import * as crypto from 'node:crypto';
import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lex from 'aws-cdk-lib/aws-lex';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as connect from 'aws-cdk-lib/aws-connect';
import { Construct } from 'constructs';
import { WaitForBuilt } from './wait-built';

/** Región fija del demo (Lex es_US y Bedrock/KB deben vivir en la misma región). */
export const LEX_FIXED_REGION = 'us-east-1';

export interface LexStackProps extends cdk.StackProps {
  readonly botName?: string;
  readonly localeId?: string;
  /**
   * ID o ARN de la Knowledge Base de Bedrock (proyecto ../kb).
   * Obligatorio en tiempo de despliegue (el AMAZON.QnAIntent necesita la
   * fuente de conocimiento). Se pasa por contexto `-c kbId=...`, mismo
   * desacoplo que `CxConnectStack -c patientLookupArn`. Si llega por
   * prop o contexto, el constructor falla claro sin ella.
   */
  readonly kbId?: string;
  /**
   * Modelo Bedrock para RetrieveAndGenerate del QnAIntent.
   * Default: amazon.nova-micro-v1:0 (el mismo del smoke de demo-kb).
   */
  readonly qnaModelArn?: string;
  /** ARN de instancia Amazon Connect para asociar bot+alias (opcional). */
  readonly connectInstanceArn?: string;
  readonly idleSessionTtlSeconds?: number;
  readonly nluConfidenceThreshold?: number;
}

function normalizeKbArn(idOrArn: string, region: string, account: string): string {
  const trimmed = idOrArn.trim();
  if (trimmed.startsWith('arn:')) return trimmed;
  return `arn:aws:bedrock:${region}:${account}:knowledge-base/${trimmed}`;
}

/** Hash corto de un objeto plano: fingerprint del contenido del bot. */
function fingerprintOf(value: unknown): string {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

/**
 * Stack único demo-lex: bot Lex V2 (locales es_US) con intents de ejemplo
 * (AgendarCita + ConsultarCita con slots y slot type propio), el built-in
 * AMAZON.QnAIntent contra la KB de Bedrock de ../kb, build automático del
 * locale, `AWS::Lex::BotVersion` y alias `prod` publicados, logs de
 * conversación y asociación opcional con Amazon Connect.
 *
 * Es espejo del flujo de la consola: crear bot → definir intents/slots →
 * Build → Publish (versión) → alias → pruebas. Sin VPC por diseño, todo
 * DESTROY, espejo de demo-kb y demo-cx.
 */
export class LexStack extends cdk.Stack {
  public readonly bot: lex.CfnBot;
  public readonly botVersion: lex.CfnBotVersion;
  public readonly botAlias: lex.CfnBotAlias;

  constructor(scope: Construct, id: string, props: LexStackProps = {}) {
    super(scope, id, props);

    if (this.region !== LEX_FIXED_REGION && !cdk.Token.isUnresolved(this.region)) {
      throw new Error(
        `LexStack solo soporta ${LEX_FIXED_REGION} (recibido ${this.region}). Despliega con env region fija.`,
      );
    }

    const botName = props.botName ?? this.node.tryGetContext('botName') ?? 'lex-clinica';
    const localeId = props.localeId ?? this.node.tryGetContext('localeId') ?? 'es_US';
    const kbId = props.kbId ?? (this.node.tryGetContext('kbId') as string | undefined);
    if (!kbId || kbId.includes('__')) {
      throw new Error(
        'LexStack requires kbId (ID o ARN de la Knowledge Base de Bedrock, proyecto ../kb). ' +
          'Despliega kb primero y pasa -c kbId=<KbId>. El AMAZON.QnAIntent necesita la KB para desplegar.',
      );
    }
    const qnaModelArn =
      props.qnaModelArn ??
      (this.node.tryGetContext('qnaModelArn') as string | undefined) ??
      `arn:aws:bedrock:${LEX_FIXED_REGION}::foundation-model/amazon.nova-micro-v1:0`;
    const connectInstanceArn =
      props.connectInstanceArn ??
      (this.node.tryGetContext('connectInstanceArn') as string | undefined);
    const idleTtl = props.idleSessionTtlSeconds ?? 300;
    const threshold = props.nluConfidenceThreshold ?? 0.4;
    const kbArn = normalizeKbArn(kbId, LEX_FIXED_REGION, this.account);

    // --- Rol IAM del bot (trust de service; la consola crea uno igual) ---
    const lexRole = new iam.Role(this, 'LexRole', {
      assumedBy: new iam.ServicePrincipal('lex.amazonaws.com'),
      description: 'Rol de Amazon Lex V2: build, QnAIntent/Bedrock y ejecución',
    });
    // Endurece el trust con SourceAccount (cuando la cuenta es conocida).
    const cfnRole = lexRole.node.defaultChild as iam.CfnRole;
    if (!cdk.Token.isUnresolved(this.account)) {
      cfnRole.addPropertyOverride('AssumeRolePolicyDocument', {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'lex.amazonaws.com' },
            Action: 'sts:AssumeRole',
            Condition: { StringEquals: { 'aws:SourceAccount': this.account } },
          },
        ],
      });
    }
    // KB: se limita la política al recurso de la base de conocimiento.
    const kbResources = [kbArn, `${kbArn}/*`];
    lexRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:RetrieveAndGenerate', 'bedrock:Retrieve'],
        resources: kbResources,
      }),
    );
    lexRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [qnaModelArn],
      }),
    );

    // --- Definición del locale (es_US): slots types, intents, utterances ---
    // Objeto plano: sirve de entrada al CfnBot y de fuente para el
    // fingerprint (cualquier cambio aquí dispara Build + versión nueva).
    const localeSpec: lex.CfnBot.BotLocaleProperty = {
      localeId,
      description: `Locale ${localeId} del bot de demo`,
      nluConfidenceThreshold: threshold,
      voiceSettings: { voiceId: 'Lupe', engine: 'neural' },
      slotTypes: [
        {
          name: 'Especialidad',
          description: 'Especialidades médicas de la clínica',
          // Lex exige ValueSelectionSetting aunque CFN lo marque opcional.
          // TOP_RESOLUTION: permite sinónimos y devuelve el valor canónico.
          valueSelectionSetting: { resolutionStrategy: 'TOP_RESOLUTION' },
          slotTypeValues: [
            {
              sampleValue: { value: 'Medicina general' },
              synonyms: [
                { value: 'medicina general' },
                { value: 'general' },
                { value: 'medicina' },
              ],
            },
            {
              sampleValue: { value: 'Cardiologia' },
              synonyms: [{ value: 'cardiología' }, { value: 'cardio' }],
            },
            {
              sampleValue: { value: 'Pediatria' },
              synonyms: [{ value: 'pediatría' }, { value: 'pedia' }],
            },
          ],
        },
      ],
      intents: [
        {
          name: 'AgendarCita',
          description: 'Agendar una cita médica con especialidad y fecha',
          sampleUtterances: [
            { utterance: 'quiero agendar una cita' },
            { utterance: 'necesito una cita medica' },
            { utterance: 'agenda una cita' },
            { utterance: 'quiero una cita de {Especialidad}' },
            { utterance: 'agendar cita para {Fecha}' },
          ],
          initialResponseSetting: {
            initialResponse: {
              messageGroupsList: [
                {
                  message: {
                    plainTextMessage: {
                      value: 'Con gusto, voy a agendar tu cita medica.',
                    },
                  },
                },
              ],
            },
            nextStep: {
              dialogAction: { type: 'ElicitSlot', slotToElicit: 'Especialidad' },
            },
          },
          slotPriorities: [
            { priority: 1, slotName: 'Especialidad' },
            { priority: 2, slotName: 'Fecha' },
          ],
          slots: [
            {
              name: 'Especialidad',
              description: 'Especialidad médica requerida',
              slotTypeName: 'Especialidad',
              valueElicitationSetting: {
                slotConstraint: 'Required',
                promptSpecification: {
                  maxRetries: 2,
                  messageGroupsList: [
                    {
                      message: {
                        plainTextMessage: { value: '¿Que especialidad necesitas?' },
                      },
                    },
                  ],
                },
              },
            },
            {
              name: 'Fecha',
              description: 'Fecha de la cita',
              slotTypeName: 'AMAZON.Date',
              valueElicitationSetting: {
                slotConstraint: 'Required',
                promptSpecification: {
                  maxRetries: 2,
                  messageGroupsList: [
                    {
                      message: {
                        plainTextMessage: { value: '¿Para que fecha quieres la cita?' },
                      },
                    },
                  ],
                },
              },
            },
          ],
          intentClosingSetting: {
            closingResponse: {
              messageGroupsList: [
                {
                  message: {
                    plainTextMessage: {
                      value: 'Tu cita de {Especialidad} quedo agendada para el {Fecha}.',
                    },
                  },
                },
              ],
            },
          },
        },
        {
          name: 'ConsultarCita',
          description: 'Consultar el estado de una cita existente',
          sampleUtterances: [
            { utterance: 'quiero consultar mi cita' },
            { utterance: 'consultar cita' },
            { utterance: 'estado de mi cita' },
          ],
          slotPriorities: [{ priority: 1, slotName: 'Correo' }],
          slots: [
            {
              name: 'Correo',
              description: 'Correo con el que se agendo la cita',
              slotTypeName: 'AMAZON.EmailAddress',
              valueElicitationSetting: {
                slotConstraint: 'Required',
                promptSpecification: {
                  maxRetries: 2,
                  messageGroupsList: [
                    {
                      message: {
                        plainTextMessage: { value: '¿Cual es el correo de tu reserva?' },
                      },
                    },
                  ],
                },
              },
            },
          ],
          intentClosingSetting: {
            closingResponse: {
              messageGroupsList: [
                {
                  message: {
                    plainTextMessage: {
                      value:
                        'La cita asociada a {Correo} esta confirmada. Te contactaremos por ese medio.',
                    },
                  },
                },
              ],
            },
          },
        },
        {
          // Built-in AMAZON.QnAIntent: en la consola se agrega con
          // "QnA intent" + "Connect to knowledge base" (Bedrock).
          name: 'QnAIntent',
          displayName: 'QnAIntent',
          parentIntentSignature: 'AMAZON.QnAIntent',
          // Utterances en ASCII plano: Lex rechaza signos como ¿ ? en el build.
          sampleUtterances: [
            { utterance: 'que informacion tienes disponible' },
            { utterance: 'buscar documentos' },
            { utterance: 'ayudame con el proceso' },
          ],
          qnAIntentConfiguration: {
            bedrockModelConfiguration: {
              modelArn: qnaModelArn,
              bedrockTraceStatus: 'ENABLED',
            },
            dataSourceConfiguration: {
              bedrockKnowledgeStoreConfiguration: {
                bedrockKnowledgeBaseArn: kbArn,
                // Requerido por Lex aunque CFN lo marque opcional: sin él el
                // import falla con NPE en exactResponse().
                exactResponse: false,
              },
            },
          },
        },
        {
          // Obligatorio: CFN exige AMAZON.FallbackIntent para crear el bot.
          // Los built-in solo admiten dialog hook / fulfillment / closing:
          // no llevan sampleUtterances ni description.
          name: 'FallbackIntent',
          parentIntentSignature: 'AMAZON.FallbackIntent',
          intentClosingSetting: {
            closingResponse: {
              messageGroupsList: [
                {
                  message: {
                    plainTextMessage: {
                      value: 'No entendi. Prueba con "quiero agendar una cita".',
                    },
                  },
                },
              ],
            },
          },
        },
      ],
    };

    const fingerprint = fingerprintOf({ botName, localeSpec, qnaModelArn, kbArn });

    // --- Bot Lex V2 (consola: crear bot + definición del locale) ---
    this.bot = new lex.CfnBot(this, 'Bot', {
      name: botName,
      description:
        'Demo bot: AgendarCita + ConsultarCita + AMAZON.QnAIntent sobre Bedrock KB (../kb)',
      dataPrivacy: { ChildDirected: false },
      idleSessionTtlInSeconds: idleTtl,
      roleArn: lexRole.roleArn,
      // El build lo hace el custom resource WaitForBuilt (único compilador):
      // con true, CFN lanza su propio build en paralelo y el handler choca
      // con "Build operation can not be performed ... ReadyExpressTesting".
      autoBuildBotLocales: false,
      botLocales: [localeSpec],
    });

    // --- Custom resource "Build" (consola: Ctrl+Build; gate para la versión) ---
    const wait = new WaitForBuilt(this, 'WaitBuilt', {
      botName,
      localeId,
      fingerprint,
    });
    wait.bind(this.bot);

    // --- Versión publicada (consola: Publish, source DRAFT) ---
    // La descripción lleva el fingerprint del contenido: al cambiar el
    // bot, CFN reemplaza la versión (create-only) y el alias la recoge.
    this.botVersion = new lex.CfnBotVersion(this, 'Version', {
      botId: this.bot.attrId,
      description: `Version publicada del bot de demo (${fingerprint})`,
      botVersionLocaleSpecification: [
        {
          localeId,
          botVersionLocaleDetails: { sourceBotVersion: 'DRAFT' },
        },
      ],
    });
    this.botVersion.node.addDependency(wait.resource);

    // --- Alias prod (lo que consumen apps y Connect) ---
    this.botAlias = new lex.CfnBotAlias(this, 'AliasProd', {
      botId: this.bot.attrId,
      botAliasName: 'prod',
      description: 'Alias de produccion consumido por apps y Connect',
      botVersion: this.botVersion.attrBotVersion,
      botAliasLocaleSettings: [
        {
          localeId,
          botAliasLocaleSetting: { enabled: true },
        },
      ],
    });
    this.botAlias.node.addDependency(this.botVersion);

    // --- Logs de conversación de texto (consola: Alias > Conversation logs) ---
    const textLogGroup = new logs.LogGroup(this, 'ConversationTextLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    textLogGroup.grantWrite(new iam.ServicePrincipal('lex.amazonaws.com'));
    this.botAlias.addPropertyOverride('ConversationLogSettings', {
      TextLogSettings: [
        {
          Enabled: true,
          Destination: {
            CloudWatch: {
              CloudWatchLogGroupArn: textLogGroup.logGroupArn,
              LogPrefix: botName,
            },
          },
        },
      ],
    });

    // --- Asociación opcional con Amazon Connect (../cx) ---
    // Equivale a consola Connect -> Flows -> Amazon Lex -> añadir bot/alias:
    // otorga el permiso recurso-a-recurso para el bloque "Get customer input".
    if (connectInstanceArn) {
      if (connectInstanceArn.includes('__') || !connectInstanceArn.startsWith('arn:aws:connect:')) {
        throw new Error(
          'connectInstanceArn debe ser un ARN real de instancia Connect ' +
            '(arn:aws:connect:us-east-1:<acct>:instance/<id>).',
        );
      }
      new connect.CfnIntegrationAssociation(this, 'ConnectAssociation', {
        instanceId: connectInstanceArn,
        integrationArn: lex.CfnBotAlias.arnForBotAlias(this.botAlias),
        integrationType: 'LEX_BOT',
      });
    }

    // --- Outputs (consumidos por scripts/smoke.mjs y por ../cx) ---
    new cdk.CfnOutput(this, 'BotId', { value: this.bot.attrId });
    new cdk.CfnOutput(this, 'BotAliasId', { value: this.botAlias.attrBotAliasId });
    new cdk.CfnOutput(this, 'BotVersion', { value: this.botVersion.attrBotVersion });
    new cdk.CfnOutput(this, 'BotAliasArn', { value: lex.CfnBotAlias.arnForBotAlias(this.botAlias) });
  }
}