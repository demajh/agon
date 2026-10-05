# @agon/adapters

Target adapters: how the engine drives the software under test. Every adapter implements the
`Adapter` / `AdapterSession` interfaces from `@agon/spec`: `open` a session against a variant,
`observe` what the simulated user perceives, `act` on it, `drainEvents` the adapter captured or
inferred, `close`. The engine never knows which kind of target it is driving.

| Adapter | Target kind | Transport | Persona |
| --- | --- | --- | --- |
| `createWebAdapter` | `web` | Playwright, headless Chromium | a person |
| `createMcpAdapter` | `mcp` | MCP client over stdio, Streamable HTTP or SSE | an AI agent (`persona.harness`) |

Shared helpers: `pruneObservation` (perception degradation by persona attention), `buildObservation`,
`normalizeText`, `observationHash`.

## Web adapter

```ts
import { createWebAdapter } from '@agon/adapters';

const adapter = createWebAdapter({ headless: true });
const session = await adapter.open(variant, openOptions);
const observation = await session.observe({ maxTextChars: 3000, maxInteractive: 30 });
await session.act({ type: 'click', ref: observation.interactive[0].ref });
await session.close();
await adapter.dispose();
```

- One Chromium per adapter (launched lazily), one isolated browser context per session with the
  persona's device, viewport, locale and the variant / session headers.
- `observe` returns the page's readable text and its interactive elements (`e1`, `e2`, … refs,
  stable while the element stays on the page), console / page / network errors since the previous
  observe, and a hash of what was returned.
- `act` supports `click`, `fill`, `select`, `press`, `navigate`, `scroll`, `back`, `wait`, `done`,
  `give_up`. Recoverable failures come back as `{ ok: false, error }`; only a page or browser that is
  gone throws `AdapterError`.
- The app's own analytics calls (PostHog, Segment, Amplitude, GA) are intercepted via routing and an
  injected guard for `fetch` / `sendBeacon`, parsed into `EventDraft`s with `source: 'intercepted'`,
  and blocked from reaching the real project unless `capture.forwardAnalytics` is set. `$pageview`
  and `$agon_error` are inferred.

## MCP adapter

Agon connects to a Model Context Protocol server as a client, so a population of simulated agents
(coding assistants, custom tool loops) can be run against it. The observation is the server's
catalog; the actions are tool calls.

```ts
import { createMcpAdapter } from '@agon/adapters';

const adapter = createMcpAdapter({ connectTimeoutMs: 15_000, callTimeoutMs: 60_000 });

// Streamable HTTP (falls back to the legacy SSE transport when the server rejects it):
const remote = await adapter.open({ url: 'https://mcp.example.com/mcp', headers: { authorization: 'Bearer …' }, env: {} }, openOptions);

// stdio: the command is tokenised like a shell (quotes honoured, nothing expanded) and spawned
// with variant.env plus the session credentials (setup hook output) in its environment:
const local = await adapter.open({ command: 'npx -y @modelcontextprotocol/server-filesystem /tmp', env: {}, headers: {} }, openOptions);
```

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `connectTimeoutMs` | 15 000 | Deadline for spawning / reaching the server and finishing `initialize`. `OpenOptions.timeoutMs` overrides it per session. |
| `callTimeoutMs` | 60 000 | Timeout for every request once connected: listings, tool calls, resource reads, prompt fetches. |
| `maxResultChars` | 8 000 | Cap on the last result text kept and shown in the observation. |
| `connect` | — | `(variant, openOptions) => Promise<Transport>`: replaces transport selection, e.g. an `InMemoryTransport` in tests. |
| `clientInfo` | `MCP_CLIENT_INFO` | Identity sent in the `initialize` handshake. |

### Observation

`url` is the variant url, or `mcp://<server name>` for stdio. `title` is the server's name and
version. `interactive` lists tools as `{ ref: 't1', role: 'tool', name }`, resources as
`{ ref: 'r1', role: 'resource', name: uri, href: uri }` and prompts as `{ ref: 'p1', role: 'prompt', name }`.
Refs are keyed by name, so they stay stable across observes; the catalog is re-listed on every
observe and new entries get new refs. `errors` holds tool and transport errors since the previous
observe. `hash` is a sha1 of the catalog names and the last call's outcome, independent of the
`maxTextChars` / `maxInteractive` caps.

`text` is the catalog followed by the last result. Schemas are rendered on one line,
TypeScript-style: `?` marks optional parameters, enums list their values, defaults follow `=`,
parameter descriptions sit in parentheses; each schema is cut at about 400 characters. Explicit
`destructive`, `read-only` and `idempotent` annotation hints are shown in brackets.

```
TOOLS (4):
t1 create_project — Create a new project in the ledger.
   args: {name: string (Display name of the project), currency?: "USD" | "EUR" (Billing currency; defaults to USD)}
t2 list_projects — List every project with its id, name and currency. [read-only]
   args: {}
t3 delete_project — Delete a project by id. [destructive]
   args: {id: string (Project id, e.g. p1)}
t4 flaky — Fails the first time it is called, then succeeds.
   args: {n: integer (Any integer)}
RESOURCES (1):
r1 ledger://projects — Projects: All projects as JSON (application/json)
PROMPTS (1):
p1 monthly_close — Walk through the monthly close for every project.
LAST RESULT:
created project "Apollo" (p1)
```

After a failed call the tail reads:

```
LAST RESULT:
(tool create_project failed)
LAST ERROR:
Input validation error: Invalid arguments for tool create_project: …
```

### Actions

| Action | Effect |
| --- | --- |
| `tool_call { ref, arguments }` | `tools/call`; the result's text blocks become LAST RESULT (images, audio and binary resources are described in brackets). A result with `isError`, or a thrown error, is `{ ok: false, error }` with the server's message clipped to 500 characters. Arguments are not validated client-side: a server's schema rejection is surfaced as-is. |
| `click { ref }` | On a resource: `resources/read`. On a prompt: `prompts/get` with no arguments. On a tool: `ok: false`, use `tool_call`. |
| `navigate { url }` | `resources/read` when the url is a listed resource uri, else `ok: false`. |
| `wait`, `done`, `give_up` | `ok: true`. |
| `fill`, `select`, `press`, `scroll`, `back` | `ok: false`, not applicable to an MCP server. |

Unknown refs are `ok: false` ("no such ref"). `AdapterError` is reserved for a connection that
could not be made or is gone; `screenshot()` is `undefined`.

### Events

Every tool call queues `$agon_tool_call { tool, arguments, duration_ms, is_error, result_chars }`
(`source: 'inferred'`); a failed one also queues `$agon_tool_error { tool, error }`. Resource and
prompt reads produce no events. `drainEvents()` returns and clears the queue.

### Pure helpers

`compactSchema`, `renderToolCatalog`, `renderObservationText`, `catalogHash`,
`renderCallToolResult`, `renderReadResourceResult`, `renderGetPromptResult`, `parseCommand`,
`formatCommand` are exported for unit tests and for other adapters that render tool catalogs.

## Tests

`pnpm -F @agon/adapters test`. The web suite drives real headless Chromium against the fixture
server in `src/web/__fixtures__`. The MCP suite links the fixture ledger server
(`src/mcp/__fixtures__/ledger-server.ts`, built with the SDK's `McpServer`) through an in-memory
transport, then proves the real transports once each: stdio by spawning the fixture with `tsx`, and
Streamable HTTP plus the SSE fallback against a `node:http` server. No network beyond localhost, no
API keys.
