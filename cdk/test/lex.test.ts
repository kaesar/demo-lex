import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { LexStack } from '../lib/lex-stack';

const ENV = { account: '123456789012', region: 'us-east-1' };
const KB_ID = 'ABCDEF1234';
const CONNECT_ARN =
  'arn:aws:connect:us-east-1:123456789012:instance/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('Demo-Lex stack synthesizes (bot + intents + QnA + version + alias)', () => {
  test('Despliega bot Lex V2 con locale es_US, intents, slots y fallback', () => {
    const app = new cdk.App();
    const stack = new LexStack(app, 'TLex', { env: ENV, kbId: KB_ID });
    const t = Template.fromStack(stack);

    t.resourceCountIs('AWS::Lex::Bot', 1);
    t.resourceCountIs('AWS::Lex::BotVersion', 1);
    t.resourceCountIs('AWS::Lex::BotAlias', 1);
    // Custom resource del build + la Lambda (más la del framework CDK)
    t.resourceCountIs('AWS::CloudFormation::CustomResource', 1);
    t.resourceCountIs('AWS::Logs::LogGroup', 3); // 2 del provider + 1 de conversación

    const json = JSON.stringify(t.toJSON());
    expect(json).toContain('lex-clinica');
    expect(json).toContain('es_US');
    expect(json).toContain('AgendarCita');
    expect(json).toContain('ConsultarCita');
    expect(json).toContain('AMAZON.QnAIntent');
    expect(json).toContain('AMAZON.FallbackIntent');
    expect(json).toContain('AMAZON.Date');
    expect(json).toContain('AMAZON.EmailAddress');
    expect(json).toContain('Especialidad');
    // KB enlazada por ARN desde el ID
    expect(json).toContain(
      'arn:aws:bedrock:us-east-1:123456789012:knowledge-base/ABCDEF1234',
    );
    expect(json).toContain('amazon.nova-micro-v1:0');
    // Alias prod con versión publicada
    expect(json).toContain('"BotAliasName":"prod"');
    expect(json).toContain('BotVersionLocaleDetails');
    expect(json).toContain('SourceBotVersion');
    expect(json).toContain('ConversationLogSettings');
  });

  test('Sin kbId falla claro en synth (el QnAIntent necesita la KB)', () => {
    const app = new cdk.App();
    expect(() => new LexStack(app, 'TLexNoKb', { env: ENV })).toThrow(/kbId/);
  });

  test('Con connectInstanceArn asocia bot+alias a la instancia (LEX_BOT)', () => {
    const app = new cdk.App();
    const stack = new LexStack(app, 'TLexConnect', {
      env: ENV,
      kbId: KB_ID,
      connectInstanceArn: CONNECT_ARN,
    });
    const t = Template.fromStack(stack);
    t.resourceCountIs('AWS::Connect::IntegrationAssociation', 1);
    const json = JSON.stringify(t.toJSON());
    expect(json).toContain('LEX_BOT');
    expect(json).toContain(CONNECT_ARN);
  });

  test('connectInstanceArn inválido falla claro en synth', () => {
    const app = new cdk.App();
    expect(
      () =>
        new LexStack(app, 'TLexBadConnect', {
          env: ENV,
          kbId: KB_ID,
          connectInstanceArn: '__PENDING__',
        }),
    ).toThrow(/connectInstanceArn/);
  });

  test('Región distinta a us-east-1 falla claro', () => {
    const app = new cdk.App();
    expect(
      () => new LexStack(app, 'TLexRegion', { env: { ...ENV, region: 'eu-west-1' } }),
    ).toThrow(/us-east-1/);
  });

  test('Sin VPC: ninguna Lambda declara VpcConfig', () => {
    const app = new cdk.App();
    const stack = new LexStack(app, 'TLexVpc', { env: ENV, kbId: KB_ID });
    const lambdas = Template.fromStack(stack).findResources('AWS::Lambda::Function');
    Object.values(lambdas).forEach((fn: any) => {
      expect(fn.Properties?.VpcConfig).toBeUndefined();
    });
  });
});