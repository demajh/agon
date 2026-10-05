# @agon/sdk

TypeScript client for the Agon control-plane API. `src/generated/types.ts` is generated from the
server's OpenAPI document (`openapi.json`, written by `pnpm generate` at the repo root) and is never
edited by hand; `src/index.ts` wraps it with a typed [`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/)
client and a few helpers.

```ts
import { readFileSync } from 'node:fs';
import { AgonApiError, createAgonClient } from '@agon/sdk';

const agon = createAgonClient({ baseUrl: 'http://localhost:4000', apiKey: process.env.AGON_API_KEY! });

// agon.yaml must have its ${...} placeholders resolved before upload; the server never expands them.
const env = await agon.environments.create(readFileSync('agon.yaml', 'utf8'));
await agon.variants.register(env.id, { name: 'pr-42', spec: { url: 'https://pr-42.preview.app' }, squad: 'blue' });

const queued = await agon.runs.start(env.id, { variants: ['control', 'pr-42'], size: 60 });
const run = await agon.runs.wait(queued.id, { pollMs: 2000, onProgress: (r) => console.log(r.status, r.counts) });
if (run.status === 'completed') {
  const result = await agon.runs.result(run.id); // a forecast: show result.calibration.note next to any lift
  console.log(result.decision.verdict, result.decision.variant, result.calibration.note);
  const [first] = await agon.runs.allSessions(run.id);
  if (first) console.log((await agon.sessions.trace(first.id)).steps.length, 'steps');
}
try {
  await agon.squads.pause('sqd_...', { reason: 'Three losing runs' }); // writes a Decision first
} catch (error) {
  if (error instanceof AgonApiError) console.error(error.status, error.code, error.message);
}
```

## Surface

| Helper | Calls |
| --- | --- |
| `health()` | `GET /healthz` |
| `environments.create(config \| yaml, { name? })`, `.get`, `.list`, `.replace`, `.delete`, `.validate(id, config \| yaml)` | `/v1/environments…` |
| `variants.register(envId, { name, spec, squad?, gitRef? })`, `.list(envId)` | `/v1/environments/{id}/variants` |
| `runs.start(envId, request?)`, `.get`, `.list(envId, query?)`, `.cancel`, `.wait(id, { pollMs?, timeoutMs?, onProgress?, signal? })`, `.result`, `.sessions(id, query?)`, `.allSessions`, `.screenshot(runId, stepId)` | `/v1/runs…` |
| `sessions.get`, `.trace` | `/v1/sessions/{id}`, `/v1/sessions/{id}/trace` |
| `personas.list()` | `GET /v1/personas` |
| `squads.create`, `.list`, `.get`, `.update`, `.leaderboard`, `.pause`, `.resume`, `.kill`, `.reallocate` | `/v1/squads…` |
| `decisions.list(query?)`, `.get`, `.approve`, `.reject` | `/v1/decisions…` |
| `apiKeys.create`, `.list`, `.revoke` | `/v1/api-keys…` |
| `client` | the raw `openapi-fetch` client, typed with `paths` |

Errors: every helper throws `AgonApiError { status, code, message, details, url }` for non-2xx responses
(`code` is the server's stable error code, e.g. `not_found`, `validation_error`, `forbidden`); `runs.wait`
throws `AgonTimeoutError` when the run does not reach `completed`, `failed` or `cancelled` in time.

Types: `AgonConfig`, `Environment`, `Run`, `Session`, `Step`, `AgonEvent`, `Result`, `Squad`, `Decision`,
`Persona`, `Variant`, `ApiKey`, `SquadControlMessage`, `WebhookEnvelope` and the rest are re-exported
from the generated document (`components['schemas']`), together with `paths` and `webhooks`.

## Regenerating

```
pnpm generate            # at the repo root: export openapi.json from @agon/server and regenerate types
pnpm -F @agon/sdk test
```
