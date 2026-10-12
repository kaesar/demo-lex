# HELP — demo-lex

## Costos (demo)

* **Lex V2**: ~$0.00075 por request de texto / ~$0.004 de voz (por turno;
  cada elicitación factura). Un smoke de 2 turnos ≈ fracciones de centavo.
* **Bedrock Nova Micro** (`retrieve-and-generate` desde el QnAIntent):
  céntimos por request, barato.
* CloudWatch Logs de conversación: retención 7 días, insignificante.
* Sin VPC, sin instancias de cómputo. Todo `DESTROY`: `npm run destroy:lex:dev`.

## Límites y notas

* Todo en `us-east-1`: Lex `es_US` solo existe ahí; la KB de `demo-kb`
  también vive allí. El stack falla claro en otra región.
* El **QnAIntent exige `kbId`** (ID o ARN de la KB): es el desacoplo de la
  pieza 3 del `DEPLOY.md` de demo-kb. Sin `-c kbId=...` el synth falla a
  propósito (`LexStack requires kbId...`).
* `connectInstanceArn` es opcional y debe ser un ARN real
  (`arn:aws:connect:us-east-1:<acct>:instance/<id>`); con `__PLACEHOLDER__`
  o ARN malformado el synth falla claro.
* `FallbackIntent` es obligatorio: CloudFormation **no crea el bot** si el
  locale no incluye el built-in `AMAZON.FallbackIntent`.
* El build del locale y la versión son **no-CFN en parte**: el custom
  resource `WaitForBuilt` llama `BuildBotLocale` y espera `Built` (gate);
  cualquier cambio de contenido (utterances, slots, prompts, KB) cambia el
  fingerprint y dispara una versión nueva. El alias `prod` es quien se mueve.
* El SDK de Lex se resuelve desde el runtime Node 22 del Lambda
  (`externalModules`), el bundle no lo duplica.

## Notas de implementación

* **ARN de KB con cuenta**: `normalizeKbArn` construye
  `arn:aws:bedrock:<region>:<account>:knowledge-base/<id>`; el validador de
  CloudFormation rechaza el ARN sin segmento de cuenta.
* **DataPrivacy en CFN**: la propiedad es `{ ChildDirected: false }`
  (PascalCase), no `childDirected` como en la CLI.
* **Custom resource**: el `DependsOn` al bot evita que corra antes de que
  exista; el handler localiza el bot por nombre (`ListBots`) y el locale por
  estado, sin tokens de CFN pendientes.
* **Logs de conversación**: `LogGroup` + resource policy de
  `lex.amazonaws.com` (permiso `logs:CreateLogStream`/`PutLogEvents`).

## Errores comunes

* `PreconditionFailedException` al crear la versión → el locale no está
  `Built` (el custom resource quedó `Failed`; mira CloudWatch del handler).
* El bot no responde al QnA → la KB no está ingerida (`npm run ingest` en
  ../kb) o el modelo no está habilitado en Bedrock `us-east-1`.
* `AccessDenied ... bedrock:InvokeModel` → habilita Nova Micro en Bedrock
  console (Model access).
* Smoke con `BotAliasStatus: Creating/Failed` → el alias tardó en estar
  `Available`; reintenta en unos segundos.