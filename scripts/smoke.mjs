#!/usr/bin/env node
// Smoke post-deploy: reconoce texto contra el alias prod del bot.
// Uso: node scripts/smoke.mjs ['quiero agendar una cita' | --slots <msj>]
import { LexRuntimeV2Client, RecognizeTextCommand } from '@aws-sdk/client-lex-runtime-v2';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

const REGION = 'us-east-1';
const STACK = process.env.STACK_NAME ?? 'LexStack';

async function outputs() {
  const cfn = new CloudFormationClient({ region: REGION });
  const res = await cfn.send(new DescribeStacksCommand({ StackName: STACK }));
  const out = {};
  for (const o of res.Stacks?.[0]?.Outputs ?? []) out[o.OutputKey] = o.OutputValue;
  return out;
}

const out = await outputs();
const botId = process.env.BOT_ID ?? out.BotId;
const aliasId = process.env.BOT_ALIAS_ID ?? out.BotAliasId;
if (!botId || !aliasId) {
  throw new Error('Faltan BotId/BotAliasId (despliega LexStack primero)');
}

const client = new LexRuntimeV2Client({ region: REGION });

async function turn(sessionId, text) {
  const res = await client.send(
    new RecognizeTextCommand({
      botId,
      botAliasId: aliasId,
      localeId: process.env.LOCALE_ID ?? 'es_US',
      sessionId,
      text,
    }),
  );
  const messages = (res.messages ?? []).map((m) => m.content).join(' | ');
  const intent = res.sessionState?.intent?.name ?? '(ninguno)';
  const slot = res.sessionState?.intent?.slots;
  console.log(`> ${text}`);
  console.log(`  intent=${intent} dialogAction=${res.sessionState?.dialogAction?.type}`);
  console.log(`  slots=${JSON.stringify(slot ?? {})}`);
  if (messages) console.log(`  bot: ${messages}`);
  return res;
}

const sessionId = `smoke-${Date.now()}`;
const input = process.argv[2] ?? 'quiero agendar una cita';

const r1 = await turn(sessionId, input);
if (r1.sessionState?.dialogAction?.type === 'ElicitSlot') {
  // Completa el slot que falte para demostrar el flujo de elicitación.
  const missing = r1.sessionState.dialogAction.slotToElicit;
  const answer = missing === 'Especialidad' ? 'cardiologia' : '2026-11-30';
  await turn(sessionId, answer);
}