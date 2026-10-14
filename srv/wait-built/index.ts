/**
 * Handler del custom resource WaitForBuilt: compila (BuildBotLocale) el
 * locale DRAFT de un bot Lex y espera a que quede `Built`, o falla con un
 * mensaje claro si el build falla.
 *
 * El bot se localiza por nombre (ListBots) y el locale por descripción de
 * estado (ListBotLocales sobre DRAFT), para no acoplar el stack al botId.
 */
import {
  LexModelsV2Client,
  BuildBotLocaleCommand,
  DescribeBotLocaleCommand,
  ListBotsCommand,
  ListBotLocalesCommand,
  type BotLocaleSummary,
  type BotSummary,
} from '@aws-sdk/client-lex-models-v2';

const client = new LexModelsV2Client({ region: process.env.AWS_REGION });
const POLL_MS = 10_000;
const MAX_ATTEMPTS = 60; // 10 min de espera máxima

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function findBot(name: string): Promise<BotSummary & { botId: string }> {
  let nextToken: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await client.send(new ListBotsCommand({ nextToken }));
    const found = page.botSummaries?.find((b) => b.botName === name);
    if (found?.botId) return found as BotSummary & { botId: string };
    nextToken = page.nextToken;
    if (!nextToken) break;
  }
  throw new Error(`Bot "${name}" no encontrado`);
}

async function findLocale(
  botId: string,
  localeId: string,
): Promise<BotLocaleSummary | undefined> {
  let nextToken: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await client.send(
      new ListBotLocalesCommand({ botId, botVersion: 'DRAFT', nextToken }),
    );
    const found = page.botLocaleSummaries?.find((l) => l.localeId === localeId);
    if (found) return found;
    nextToken = page.nextToken;
    if (!nextToken) break;
  }
  return undefined;
}

export async function handler(event: {
  RequestType: string;
  PhysicalResourceId?: string;
  ResourceProperties: { BotName: string; LocaleId: string; Fingerprint?: string };
}): Promise<{ PhysicalResourceId: string }> {
  const { BotName, LocaleId } = event.ResourceProperties;

  if (event.RequestType === 'Delete') {
    // No hay recurso propio que borrar: el bot/versiones viven y se borran
    // con el stack. CFN pedirá un physicalId ya conocido.
    return { PhysicalResourceId: event.PhysicalResourceId ?? `${BotName}-${LocaleId}` };
  }

  const bot = await findBot(BotName);
  const locale = await findLocale(bot.botId, LocaleId);
  if (!locale) {
    throw new Error(`Locale ${LocaleId} no encontrado en bot ${BotName}`);
  }

  // El CfnBot lleva autoBuildBotLocales=false: este handler es el único que
  // compila. Si Lex ya tiene un build en curso (Building/ReadyExpressTesting),
  // BuildBotLocale lanza ConflictException: en ese caso se pasa a polling en
  // vez de fallar (carrera entre la creación del bot y el custom resource).
  try {
    await client.send(
      new BuildBotLocaleCommand({ botId: bot.botId, botVersion: 'DRAFT', localeId: LocaleId }),
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : '';
    if (name.includes('Conflict') || msg.includes('can not be performed')) {
      console.log(`Build ya en curso (${msg}); esperando a Built por polling.`);
    } else {
      throw err;
    }
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await client.send(
      new DescribeBotLocaleCommand({
        botId: bot.botId,
        botVersion: 'DRAFT',
        localeId: LocaleId,
      }),
    );
    const status = res.botLocaleStatus;
    if (status === 'Built') {
      return { PhysicalResourceId: `${bot.botId}:${LocaleId}:${event.ResourceProperties.Fingerprint ?? '1'}` };
    }
    // Solo 'Failed' es terminal de error. 'Creating'/'Building'/'NotBuilt'/
    // 'Processing'/'Importing'/'ReadyExpressTesting' son transitorios y deben
    // seguir en polling. 'Deleting' no debería ocurrir durante un Build.
    if (status === 'Failed' || status === 'Deleting') {
      const reasons = (res.failureReasons ?? []).join(' | ') || '(sin failureReasons)';
      throw new Error(`Build del locale ${LocaleId} terminó en "${status}": ${reasons}`);
    }
    await sleep(POLL_MS);
  }

  throw new Error(`Timeout esperando build del locale ${LocaleId}`);
}