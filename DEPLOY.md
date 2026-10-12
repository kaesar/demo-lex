# DEPLOY — demo-lex

Requiere Node >= 22, AWS CLI v2, `us-east-1`, `npx cdk bootstrap aws://<account>/us-east-1`
una vez, y la KB de `demo-kb` desplegada **y ingerida**.

## 1. Obtener el KbId

```bash
cd ../kb
aws cloudformation describe-stacks --stack-name KbStack --region us-east-1 \
  --query "Stacks[0].Outputs[?OutputKey=='KbId'].OutputValue" --output text
# → export KB_ID=<ese valor>
```

## 2. Desplegar

```bash
cd ../lex
npm ci
npm run build && npm test
npm run synth -- -c kbId=$KB_ID
npm run deploy:lex:dev -- -c kbId=$KB_ID
```

Outputs útiles (`BotId`, `BotAliasId`, `BotVersion`, `BotAliasArn`):

```bash
aws cloudformation describe-stacks --stack-name LexStack --region us-east-1 \
  --query "Stacks[0].Outputs" --output table
```

## 3. Probar el bot

```bash
npm run smoke                    # "quiero agendar una cita" + rellena el slot que falte
npm run smoke -- "consultar cita" # responde con elicitación de Correo
```

El smoke usa el alias `prod` (nunca `DRAFT`), sessionId estable por
conversación y muestra intent + dialogAction + slots, como el CLI de
`Amazon-Lex.md`.

## 4. (Opcional) Asociar a Amazon Connect

Con la instancia de `demo-cx` desplegada:

```bash
npm run deploy:lex:dev -- -c kbId=$KB_ID \
  -c connectInstanceArn=arn:aws:connect:us-east-1:<acct>:instance/<id>
```

Esto crea `AWS::Connect::IntegrationAssociation` (tipo `LEX_BOT`) sobre el
alias: el bloque "Get customer input" del flow `AgendamientoMedico` ya puede
usar bot `lex-clinica` / alias `prod` y los slots llegan como atributos del
contacto (`$.Lex.Slots.Especialidad`, etc.).

## Liberar recursos

```bash
npm run destroy:lex:dev
# El bot, versión, alias, rol, logs y Lambda del custom resource se borran.
```

> Re-despliegue después de editar utterances/slots: el fingerprint cambia →
> build + versión nueva → el alias mueve el puntero automáticamente (sin
> downtime), replicando Editar → Build → Publish de la consola.