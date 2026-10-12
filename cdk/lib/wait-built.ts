import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import * as customResources from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lex from 'aws-cdk-lib/aws-lex';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface WaitForBuiltProps {
  readonly localeId: string;
  /** Nombre del bot a compilar (el handler lo localiza por nombre). */
  readonly botName: string;
  /**
   * Fingerprint del contenido del bot (hash de utterances, slots, prompts,
   * qna…). Al cambiar, el custom resource se re-ejecuta: equivale a pulsar
   * "Build" en la consola tras editar el bot.
   */
  readonly fingerprint: string;
}

/**
 * Custom resource que repite el "Build" de la consola sobre el bot:
 *
 * - localiza el bot por nombre y su locale,
 * - llama `BuildBotLocale` sobre DRAFT + locale,
 * - hace polling de `DescribeBotLocale` hasta `Built` (o falla en `Failed`).
 *
 * `AWS::Lex::BotVersion` declara su dependencia sobre este recurso: sin
 * locale `Built`, la publicación de versión falla (PreconditionFailed).
 */
export class WaitForBuilt extends Construct {
  public readonly resource: cdk.CustomResource;

  constructor(scope: Construct, id: string, props: WaitForBuiltProps) {
    super(scope, id);

    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lex:BuildBotLocale', 'lex:DescribeBotLocale', 'lex:ListBots', 'lex:ListBotLocales'],
        resources: ['*'], // Build/DescribeBotLocale no admiten ARN por recurso
      }),
    );

    const fnLogs = new logs.LogGroup(this, 'HandlerLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const onEvent = new NodejsFunction(this, 'Handler', {
      entry: path.join(__dirname, '..', '..', 'srv', 'wait-built', 'index.ts'),
      handler: 'index.handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      logGroup: fnLogs,
      role,
      bundling: {
        // El SDK v3 viene en el runtime Node 22; no inflar el bundle.
        externalModules: ['@aws-sdk/client-lex-models-v2'],
      },
    });

    const providerLogs = new logs.LogGroup(this, 'ProviderLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const provider = new customResources.Provider(this, 'Provider', {
      onEventHandler: onEvent,
      logGroup: providerLogs,
    });

    this.resource = new cdk.CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      properties: {
        BotName: props.botName,
        LocaleId: props.localeId,
        Fingerprint: props.fingerprint,
      },
    });
  }

  /** Ordena la ejecución tras el bot (no puede declararse antes de crearlo). */
  public bind(bot: lex.CfnBot): void {
    this.resource.node.addDependency(bot);
  }
}