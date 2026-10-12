#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { LexStack, LEX_FIXED_REGION } from '../lib/lex-stack';

/**
 * App única demo-lex. Región fija us-east-1: Lex español (es_US) y la
 * Knowledge Base de Bedrock de ../kb viven en la misma región.
 *
 * Desacoplo como demo-cx: la KB llega por contexto (`-c kbId=...`) y la
 * instancia Connect por `-c connectInstanceArn=...` (opcional).
 */
const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: LEX_FIXED_REGION,
};

new LexStack(app, 'LexStack', {
  env,
  description: 'Demo-Lex: bot Amazon Lex V2 (intents + slots + QnAIntent sobre Bedrock KB).',
});

app.synth();