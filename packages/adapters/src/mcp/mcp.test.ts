import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { AdapterError, INFERRED_EVENTS } from '@agon/spec';
import type {
  Action,
  AdapterSession,
  Capture,
  Observation,
  OpenOptions,
  VariantSpec,
} from '@agon/spec';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMcpAdapter, formatCommand } from '../index.js';
import type { McpAdapter } from '../index.js';
import { startLedgerHttpServer } from './__fixtures__/http-server.js';
import type { LedgerHttpServer } from './__fixtures__/http-server.js';
import { createLedgerServer } from './__fixtures__/ledger-server.js';
import type { LedgerState } from './__fixtures__/ledger-server.js';

const baseCapture: Capture = {
  analytics: [],
  forwardAnalytics: false,
  networkErrors: true,
  consoleErrors: true,
  screenshots: 'never',
};

const emptyVariant: VariantSpec = { env: {}, headers: {} };

function openOptions(overrides: Partial<OpenOptions> = {}): OpenOptions {
  return {
    sessionId: 'ses_test_00001',
    variant: 'control',
    startPath: '/',
    viewport: { width: 1280, height: 800 },
    device: 'desktop',
    locale: 'en-US',
    capture: baseCapture,
    ...overrides,
  };
}

function refOf(observation: Observation, role: string, name: string): string {
  const element = observation.interactive.find((e) => e.role === role && e.name === name);
  if (!element) {
    throw new Error(`no ${role} named "${name}" in ${JSON.stringify(observation.interactive)}`);
  }
  return element.ref;
}

const adapters: McpAdapter[] = [];

interface InMemoryFixture {
  session: AdapterSession;
  adapter: McpAdapter;
  server: McpServer;
  state: LedgerState;
}

/**
 * The ledger server and the adapter linked through an in-memory transport pair. A server holds one
 * transport, so every further session the adapter opens gets a fresh ledger server of its own.
 */
async function openInMemory(options: { maxResultChars?: number } = {}): Promise<InMemoryFixture> {
  const first = createLedgerServer();
  let used = false;
  const adapter = createMcpAdapter({
    ...options,
    connect: async () => {
      const ledger = used ? createLedgerServer() : first;
      used = true;
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await ledger.server.connect(serverTransport);
      return clientTransport;
    },
  });
  adapters.push(adapter);
  const session = await adapter.open(emptyVariant, openOptions());
  return { session, adapter, server: first.server, state: first.state };
}

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()));
});

describe('observe (in-memory transport)', () => {
  it('lists tools, resources and prompts with refs, compact schemas and a stable hash', async () => {
    const { session } = await openInMemory();
    expect(session.kind).toBe('mcp');
    const obs = await session.observe();

    expect(obs.url).toBe('mcp://ledger');
    expect(obs.title).toBe('ledger 1.0.0');
    expect(obs.interactive.map((e) => [e.ref, e.role, e.name])).toEqual([
      ['t1', 'tool', 'create_project'],
      ['t2', 'tool', 'list_projects'],
      ['t3', 'tool', 'delete_project'],
      ['t4', 'tool', 'flaky'],
      ['r1', 'resource', 'ledger://projects'],
      ['p1', 'prompt', 'monthly_close'],
    ]);
    expect(obs.interactive[4]?.href).toBe('ledger://projects');

    expect(obs.text).toContain('TOOLS (4):');
    expect(obs.text).toContain(
      't1 create_project — Create a new project in the ledger.\n   args: ',
    );
    expect(obs.text).toMatch(
      /args: \{name: string \(Display name of the project\), currency\?: "USD" \| "EUR" \(Billing currency; defaults to USD\)\}/,
    );
    expect(obs.text).toContain(
      't2 list_projects — List every project with its id, name and currency. [read-only]\n   args: {}',
    );
    expect(obs.text).toContain('t3 delete_project — Delete a project by id. [destructive]');
    expect(obs.text).toContain('args: {id: string (Project id, e.g. p1)}');
    expect(obs.text).toContain('t4 flaky — Fails the first time it is called, then succeeds.');
    expect(obs.text).toContain('args: {n: integer (Any integer)}');
    expect(obs.text).toContain(
      'RESOURCES (1):\nr1 ledger://projects — Projects: All projects as JSON (application/json)',
    );
    expect(obs.text).toContain(
      'PROMPTS (1):\np1 monthly_close — Walk through the monthly close for every project.',
    );
    expect(obs.text.endsWith('LAST RESULT:\n(none yet)')).toBe(true);
    expect(obs.errors).toEqual([]);
    expect(obs.truncated).toBe(false);
    expect(obs.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(obs.screenshotRef).toBeUndefined();
    expect(Date.parse(obs.capturedAt)).not.toBeNaN();

    const again = await session.observe();
    expect(again.hash).toBe(obs.hash);
    expect(again.interactive).toEqual(obs.interactive);
    expect(again.text).toBe(obs.text);
  });

  it('keeps refs stable when the catalog grows and gives new entries new refs', async () => {
    const { session, server } = await openInMemory();
    const before = await session.observe();
    server.registerTool(
      'audit',
      { description: 'Audit the ledger.', inputSchema: {} },
      async () => ({
        content: [{ type: 'text', text: 'ok' }],
      }),
    );
    const after = await session.observe();
    expect(after.interactive.map((e) => e.ref)).toEqual(['t1', 't2', 't3', 't4', 't5', 'r1', 'p1']);
    expect(refOf(after, 'tool', 'audit')).toBe('t5');
    expect(after.text).toContain('TOOLS (5):');
    expect(after.hash).not.toBe(before.hash);
  });

  it('caps text and interactive elements, flagging truncation without changing the hash', async () => {
    const { session } = await openInMemory();
    const full = await session.observe();
    const small = await session.observe({ maxTextChars: 100, maxInteractive: 2 });
    expect(small.text.length).toBeLessThanOrEqual(100);
    expect(small.text.startsWith('TOOLS (4):')).toBe(true);
    expect(small.interactive.map((e) => e.ref)).toEqual(['t1', 't2']);
    expect(small.truncated).toBe(true);
    expect(small.hash).toBe(full.hash);
    const invalidCaps = await session.observe({ maxTextChars: 0, maxInteractive: Number.NaN });
    expect(invalidCaps.text).toBe(full.text);
    expect(invalidCaps.interactive).toEqual(full.interactive);
  });

  it('observes servers that expose neither resources nor prompts', async () => {
    const server = new McpServer({ name: 'bare', version: '0.1.0' });
    server.registerTool('ping', { description: 'Pong.' }, async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }));
    const adapter = createMcpAdapter({
      connect: async () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        return clientTransport;
      },
    });
    adapters.push(adapter);
    const session = await adapter.open(emptyVariant, openOptions());
    const obs = await session.observe();
    expect(obs.url).toBe('mcp://bare');
    expect(obs.title).toBe('bare 0.1.0');
    expect(obs.text).toContain('TOOLS (1):\nt1 ping — Pong.\n   args: {}');
    expect(obs.text).toContain('RESOURCES (0):\n(none)');
    expect(obs.text).toContain('PROMPTS (0):\n(none)');
    expect(obs.interactive).toHaveLength(1);
    expect(obs.errors).toEqual([]);
    expect(await session.act({ type: 'tool_call', ref: 't1', arguments: {} })).toEqual({
      ok: true,
      navigated: false,
    });
    expect((await session.observe()).text).toContain('LAST RESULT:\npong');
  });
});

describe('act (in-memory transport)', () => {
  it('calls a tool, updates LAST RESULT and the hash, and emits $agon_tool_call', async () => {
    const { session, state } = await openInMemory();
    const obs = await session.observe();
    const create = refOf(obs, 'tool', 'create_project');
    session.drainEvents();

    const result = await session.act({
      type: 'tool_call',
      ref: create,
      arguments: { name: 'Apollo', currency: 'EUR' },
    });
    expect(result).toEqual({ ok: true, navigated: false });
    expect(state.projects).toEqual([{ id: 'p1', name: 'Apollo', currency: 'EUR' }]);

    const after = await session.observe();
    expect(after.text.endsWith('LAST RESULT:\ncreated project "Apollo" (p1)')).toBe(true);
    expect(after.hash).not.toBe(obs.hash);
    expect(after.errors).toEqual([]);

    const events = session.drainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: INFERRED_EVENTS.toolCall,
      source: 'inferred',
      properties: {
        tool: 'create_project',
        arguments: { name: 'Apollo', currency: 'EUR' },
        is_error: false,
        result_chars: 'created project "Apollo" (p1)'.length,
      },
    });
    expect(events[0]?.properties['duration_ms']).toEqual(expect.any(Number));
    expect(events[0]?.provider).toBeUndefined();
    expect(Date.parse(events[0]?.timestamp ?? '')).not.toBeNaN();
    expect(session.drainEvents()).toEqual([]);

    // A repeat of the same call produces the same result text, so the state hashes the same.
    const again = await session.act({
      type: 'tool_call',
      ref: create,
      arguments: { name: 'Zeus' },
    });
    expect(again.ok).toBe(true);
    expect((await session.observe()).hash).not.toBe(after.hash);
  });

  it('surfaces the server rejection of invalid arguments and emits $agon_tool_error once', async () => {
    const { session, state } = await openInMemory();
    const obs = await session.observe();
    const create = refOf(obs, 'tool', 'create_project');
    session.drainEvents();

    const rejected = await session.act({ type: 'tool_call', ref: create, arguments: { name: 42 } });
    expect(rejected.ok).toBe(false);
    expect(rejected.navigated).toBe(false);
    expect(rejected.error).toMatch(/Invalid arguments for tool create_project/);
    expect(state.projects).toEqual([]);

    const events = session.drainEvents();
    expect(events.map((e) => e.event)).toEqual([
      INFERRED_EVENTS.toolCall,
      INFERRED_EVENTS.toolError,
    ]);
    expect(events[0]?.properties).toMatchObject({
      tool: 'create_project',
      arguments: { name: 42 },
      is_error: true,
    });
    expect(events[1]?.properties).toMatchObject({
      tool: 'create_project',
      error: expect.stringMatching(/Invalid arguments for tool create_project/) as string,
    });
    expect(events.every((e) => e.source === 'inferred')).toBe(true);

    const after = await session.observe();
    expect(after.errors).toHaveLength(1);
    expect(after.errors[0]).toMatch(/^tool create_project failed: .*Invalid arguments/);
    expect(after.text).toContain('LAST RESULT:\n(tool create_project failed)\nLAST ERROR:\n');
    expect(after.text).toMatch(/LAST ERROR:\n.*Invalid arguments for tool create_project/);
    expect(after.hash).not.toBe(obs.hash);
    expect((await session.observe()).errors).toEqual([]);
  });

  it('reports isError results as ok:false and recovers when the tool succeeds', async () => {
    const { session } = await openInMemory();
    const obs = await session.observe();
    const flaky = refOf(obs, 'tool', 'flaky');
    const remove = refOf(obs, 'tool', 'delete_project');

    expect(await session.act({ type: 'tool_call', ref: flaky, arguments: { n: 3 } })).toEqual({
      ok: false,
      error: 'transient failure: try again',
      navigated: false,
    });
    expect(await session.act({ type: 'tool_call', ref: flaky, arguments: { n: 3 } })).toEqual({
      ok: true,
      navigated: false,
    });
    expect((await session.observe()).text.endsWith('LAST RESULT:\nflaky ok (n=3)')).toBe(true);

    expect(await session.act({ type: 'tool_call', ref: remove, arguments: { id: 'p9' } })).toEqual({
      ok: false,
      error: 'no project with id p9',
      navigated: false,
    });
    const errors = session.drainEvents().filter((e) => e.event === INFERRED_EVENTS.toolError);
    expect(errors.map((e) => e.properties['tool'])).toEqual(['flaky', 'delete_project']);
  });

  it('reads resources and prompts through click and navigate', async () => {
    const { session } = await openInMemory();
    const obs = await session.observe();
    await session.act({
      type: 'tool_call',
      ref: refOf(obs, 'tool', 'create_project'),
      arguments: { name: 'Zeus' },
    });

    expect(
      await session.act({ type: 'click', ref: refOf(obs, 'resource', 'ledger://projects') }),
    ).toEqual({
      ok: true,
      navigated: false,
    });
    let after = await session.observe();
    expect(after.text.endsWith('LAST RESULT:\n[{"id":"p1","name":"Zeus","currency":"USD"}]')).toBe(
      true,
    );

    expect(
      await session.act({ type: 'click', ref: refOf(obs, 'prompt', 'monthly_close') }),
    ).toEqual({
      ok: true,
      navigated: false,
    });
    after = await session.observe();
    expect(after.text).toContain(
      'LAST RESULT:\nuser: Close the books for every project: list them, then confirm each balance.',
    );

    expect(await session.act({ type: 'navigate', url: 'ledger://projects' })).toEqual({
      ok: true,
      navigated: false,
    });
    expect((await session.observe()).text).toContain('"name":"Zeus"');

    // Only the tool call produced events; reads are not tool calls.
    const events = session.drainEvents();
    expect(events.map((e) => e.event)).toEqual([INFERRED_EVENTS.toolCall]);
  });

  it('fails recoverably on unknown refs, misused refs and inapplicable actions', async () => {
    const { session } = await openInMemory();
    const obs = await session.observe();
    const create = refOf(obs, 'tool', 'create_project');

    const missing = await session.act({ type: 'tool_call', ref: 't99', arguments: {} });
    expect(missing).toMatchObject({ ok: false, navigated: false });
    expect(missing.error).toMatch(/no such ref "t99"/);
    const clickMissing = await session.act({ type: 'click', ref: 'zzz' });
    expect(clickMissing.error).toMatch(/no such ref "zzz"/);

    const clickTool = await session.act({ type: 'click', ref: create });
    expect(clickTool.ok).toBe(false);
    expect(clickTool.error).toMatch(/use tool_call with arguments/);

    const notListed = await session.act({ type: 'navigate', url: 'ledger://nope' });
    expect(notListed.ok).toBe(false);
    expect(notListed.error).toMatch(/not a resource listed in the observation/);

    const inapplicable: Action[] = [
      { type: 'fill', ref: create, text: 'x' },
      { type: 'select', ref: create, value: 'x' },
      { type: 'press', key: 'Enter' },
      { type: 'scroll', direction: 'down' },
      { type: 'back' },
    ];
    for (const action of inapplicable) {
      const result = await session.act(action);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not applicable to an MCP server/);
    }

    const invalid = await session.act({ type: 'wait', ms: -1 } as never);
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toMatch(/invalid action/);

    expect(await session.act({ type: 'wait', ms: 10 })).toEqual({ ok: true, navigated: false });
    expect(await session.act({ type: 'done', reason: 'finished' })).toEqual({
      ok: true,
      navigated: false,
    });
    expect(await session.act({ type: 'give_up', reason: 'lost' })).toEqual({
      ok: true,
      navigated: false,
    });
    // Nothing reached the server, so nothing was recorded.
    expect(session.drainEvents()).toEqual([]);
    expect((await session.observe()).errors).toEqual([]);
  });

  it('caps the stored last result at maxResultChars but reports the full size in the event', async () => {
    const { session } = await openInMemory({ maxResultChars: 12 });
    const obs = await session.observe();
    await session.act({
      type: 'tool_call',
      ref: refOf(obs, 'tool', 'create_project'),
      arguments: { name: 'Hyperion' },
    });
    const after = await session.observe();
    expect(after.text.endsWith('LAST RESULT:\ncreated pro…')).toBe(true);
    const call = session.drainEvents().find((e) => e.event === INFERRED_EVENTS.toolCall);
    expect(call?.properties['result_chars']).toBe('created project "Hyperion" (p1)'.length);
  });
});

describe('lifecycle (in-memory transport)', () => {
  it('closes idempotently and refuses to work afterwards', async () => {
    const { session } = await openInMemory();
    expect(await session.screenshot()).toBeUndefined();
    await session.close();
    await session.close();
    await expect(session.observe()).rejects.toBeInstanceOf(AdapterError);
    await expect(session.act({ type: 'wait', ms: 1 })).rejects.toMatchObject({
      code: 'adapter_error',
    });
    expect(session.drainEvents()).toEqual([]);
  });

  it('dispose closes every open session', async () => {
    const { session, adapter } = await openInMemory();
    const second = await adapter.open(emptyVariant, openOptions({ sessionId: 'ses_test_00002' }));
    await adapter.dispose();
    await expect(session.observe()).rejects.toBeInstanceOf(AdapterError);
    await expect(second.observe()).rejects.toBeInstanceOf(AdapterError);
  });

  it('turns a server that goes away into an AdapterError', async () => {
    const { session, server } = await openInMemory();
    await session.observe();
    await server.close();
    await expect(session.observe()).rejects.toMatchObject({ code: 'adapter_error' });
  });

  it('rejects variants without a url or command', async () => {
    const adapter = createMcpAdapter();
    adapters.push(adapter);
    await expect(adapter.open(emptyVariant, openOptions())).rejects.toBeInstanceOf(AdapterError);
  });
});

describe('stdio transport', () => {
  it('spawns the server from variant.command with variant.env and credentials in its environment', async () => {
    const require = createRequire(import.meta.url);
    const tsxCli = require.resolve('tsx/cli');
    const entry = fileURLToPath(new URL('./__fixtures__/ledger-stdio.ts', import.meta.url));
    const adapter = createMcpAdapter({ connectTimeoutMs: 25_000 });
    adapters.push(adapter);

    const session = await adapter.open(
      {
        command: formatCommand([process.execPath, tsxCli, entry]),
        env: { LEDGER_REGION: 'eu' },
        headers: {},
      },
      openOptions({ credentials: { LEDGER_TOKEN: 'secret' } }),
    );
    const obs = await session.observe();
    expect(obs.url).toBe('mcp://ledger');
    expect(obs.title).toBe('ledger 1.0.0');
    expect(obs.text).toContain('TOOLS (5):');

    const create = refOf(obs, 'tool', 'create_project');
    expect(
      await session.act({ type: 'tool_call', ref: create, arguments: { name: 'Stdio' } }),
    ).toEqual({ ok: true, navigated: false });
    expect((await session.observe()).text).toContain('LAST RESULT:\ncreated project "Stdio" (p1)');

    const env = refOf(obs, 'tool', 'env');
    await session.act({ type: 'tool_call', ref: env, arguments: { name: 'LEDGER_TOKEN' } });
    expect((await session.observe()).text).toContain('LAST RESULT:\nLEDGER_TOKEN=secret');
    await session.act({ type: 'tool_call', ref: env, arguments: { name: 'LEDGER_REGION' } });
    expect((await session.observe()).text).toContain('LAST RESULT:\nLEDGER_REGION=eu');

    await session.close();
    await session.close();
  });

  it('fails to open with an AdapterError when the command cannot start or cannot be parsed', async () => {
    const adapter = createMcpAdapter({ connectTimeoutMs: 5_000 });
    adapters.push(adapter);
    await expect(
      adapter.open(
        { command: 'agon-no-such-binary-xyz --flag', env: {}, headers: {} },
        openOptions(),
      ),
    ).rejects.toMatchObject({ code: 'adapter_error' });
    await expect(
      adapter.open({ command: 'node "unterminated', env: {}, headers: {} }, openOptions()),
    ).rejects.toThrow(/unterminated double quote/);
    await expect(
      adapter.open(
        {
          command: formatCommand([process.execPath, '-e', 'process.exit(3)']),
          env: {},
          headers: {},
        },
        openOptions(),
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });
});

describe('http transports', () => {
  let http: LedgerHttpServer;

  beforeAll(async () => {
    http = await startLedgerHttpServer();
  });

  afterAll(async () => {
    await http.close();
  });

  it('connects over streamable http with variant and session headers', async () => {
    const adapter = createMcpAdapter({ connectTimeoutMs: 10_000 });
    adapters.push(adapter);
    const session = await adapter.open(
      { url: http.streamableUrl, env: {}, headers: { 'x-variant-header': 'from-variant' } },
      openOptions({ headers: { 'x-agon-test': 'yes' } }),
    );
    const obs = await session.observe();
    expect(obs.url).toBe(http.streamableUrl);
    expect(obs.title).toBe('ledger 1.0.0');
    expect(obs.interactive.map((e) => e.name)).toContain('create_project');

    const create = refOf(obs, 'tool', 'create_project');
    expect(
      await session.act({ type: 'tool_call', ref: create, arguments: { name: 'Remote' } }),
    ).toEqual({ ok: true, navigated: false });
    expect((await session.observe()).text).toContain('LAST RESULT:\ncreated project "Remote" (p1)');
    expect(http.states.some((s) => s.projects.some((p) => p.name === 'Remote'))).toBe(true);

    const mcpRequests = http.requests.filter((r) => r.path === '/mcp');
    expect(mcpRequests.length).toBeGreaterThan(0);
    expect(
      mcpRequests.every(
        (r) =>
          r.headers['x-variant-header'] === 'from-variant' && r.headers['x-agon-test'] === 'yes',
      ),
    ).toBe(true);
    await session.close();
  });

  it('falls back to the sse transport when the server rejects streamable http', async () => {
    const adapter = createMcpAdapter({ connectTimeoutMs: 10_000 });
    adapters.push(adapter);
    const session = await adapter.open({ url: http.sseUrl, env: {}, headers: {} }, openOptions());
    const obs = await session.observe();
    expect(obs.url).toBe(http.sseUrl);
    expect(obs.title).toBe('ledger 1.0.0');
    const create = refOf(obs, 'tool', 'create_project');
    expect(
      await session.act({ type: 'tool_call', ref: create, arguments: { name: 'Legacy' } }),
    ).toEqual({ ok: true, navigated: false });
    expect((await session.observe()).text).toContain('LAST RESULT:\ncreated project "Legacy" (p1)');
    expect(http.requests.some((r) => r.method === 'POST' && r.path === '/sse')).toBe(true);
    expect(http.requests.some((r) => r.method === 'POST' && r.path === '/messages')).toBe(true);
    await session.close();
  });

  it('fails to open unreachable or unknown endpoints with an AdapterError', async () => {
    const adapter = createMcpAdapter({ connectTimeoutMs: 5_000 });
    adapters.push(adapter);
    await expect(
      adapter.open({ url: 'http://127.0.0.1:9/mcp', env: {}, headers: {} }, openOptions()),
    ).rejects.toMatchObject({ code: 'adapter_error' });
    await expect(
      adapter.open({ url: `${http.baseUrl}/nowhere`, env: {}, headers: {} }, openOptions()),
    ).rejects.toThrow(/streamable http: .*; sse fallback: /);
    await expect(
      adapter.open({ url: 'ftp://127.0.0.1/mcp', env: {}, headers: {} }, openOptions()),
    ).rejects.toThrow(/http\(s\) url/);
  });
});
