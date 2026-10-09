import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { FakeAdapter, FakeLlm, happyUser, ledgerlySite } from '@agon/engine/fakes';
import type { Result } from '@agon/spec';
import type { AnalyzeInput, SquadScoreInput } from '@agon/stats-client';
import { Pool } from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe } from 'vitest';
import type { BootstrapKey } from '../config.js';
import { createServer, type AgonServer, type CreateServerOptions } from '../server.js';
import type { RunDependenciesFactory, StatsClient } from '../worker/deps.js';
import { SKIP_DB_TESTS, ensureTestDatabase, truncateAll } from './db.js';

export const KEYS = {
  operator: 'test-operator-key-0001',
  observer: 'test-observer-key-0001',
  squadBlue: 'test-squad-blue-key-01',
} as const;

export const BOOTSTRAP_KEYS: BootstrapKey[] = [
  { key: KEYS.operator, role: 'operator' },
  { key: KEYS.observer, role: 'observer' },
  { key: KEYS.squadBlue, role: 'squad', squadSlug: 'blue' },
];

/** `describe` for suites that need Postgres; skipped when `AGON_SKIP_DB_TESTS=1`. */
export function describeDb(name: string, factory: () => void): void {
  if (SKIP_DB_TESTS) describe.skip(name, factory);
  else describe(name, factory);
}

export interface RequestOptions {
  key?: string | null | undefined;
  body?: unknown;
  text?: string | undefined;
  contentType?: string | undefined;
  headers?: Record<string, string> | undefined;
}

export interface TestResponse {
  status: number;
  json: <T = unknown>() => Promise<T>;
  text: () => Promise<string>;
  response: Response;
}

export interface FetchStub {
  calls: { url: string; init: RequestInit; body: unknown }[];
  fetch: typeof globalThis.fetch;
}

/** A `fetch` that records every call and answers 200 (or the configured status). */
export function fetchStub(status = 200): FetchStub {
  const stub: FetchStub = {
    calls: [],
    fetch: async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const raw = init?.body;
      let body: unknown = raw;
      if (typeof raw === 'string') {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      stub.calls.push({ url, init: init ?? {}, body });
      return new Response(status >= 200 && status < 300 ? '{"ok":true}' : '{"ok":false}', {
        status,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  return stub;
}

export interface TestServerOptions {
  runDependencies?: RunDependenciesFactory | undefined;
  stats?: StatsClient | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  webhookUrl?: string | undefined;
  bootstrapKeys?: BootstrapKey[] | undefined;
  role?: CreateServerOptions['config']['role'];
}

export interface TestServer {
  server: AgonServer;
  dataDir: string;
  pool: Pool;
  request(method: string, path: string, options?: RequestOptions): Promise<TestResponse>;
  truncate(): Promise<void>;
  stop(): Promise<void>;
}

/** The engine fakes: scripted Ledgerly site plus a scripted eager user. */
export const fakeRunDependencies: RunDependenciesFactory = () => ({
  llm: new FakeLlm(happyUser),
  adapter: new FakeAdapter(ledgerlySite),
});

/** A stats client that fabricates a plausible Result without Python; `uv` is not needed. */
export function stubStats(
  overrides: { verdict?: Result['decision']['verdict']; variant?: string } = {},
): StatsClient {
  return {
    async analyze(input: AnalyzeInput): Promise<Result> {
      const variants = Object.keys(
        input.analysis.metrics.length ? { control: 1, treatment: 1 } : {},
      );
      const control = input.analysis.control;
      const treatment = variants.find((v) => v !== control) ?? 'treatment';
      const primary = input.analysis.metrics.find((m) => m.primary) ?? input.analysis.metrics[0];
      const metricId = primary?.id ?? 'scenario_success';
      return {
        id: `res_${input.analysis.runId.replace(/^run_/, '')}`,
        runId: input.analysis.runId,
        method: input.analysis.method,
        control,
        primaryMetricId: metricId,
        metrics: [
          {
            metricId,
            direction: 'increase',
            variants: [
              { variant: control, sessions: 2, successes: 2, mean: 1, stderr: 0, ci95: [1, 1] },
              { variant: treatment, sessions: 2, successes: 2, mean: 1, stderr: 0, ci95: [1, 1] },
            ],
            comparisons: [
              {
                variant: treatment,
                control,
                lift: 0.1,
                liftCi95: [-0.1, 0.3],
                pBest: 0.97,
                pBeatControl: 0.97,
                expectedLoss: 0.001,
              },
            ],
            warnings: [],
          },
        ],
        decision: {
          verdict: overrides.verdict ?? 'ship',
          ...(overrides.verdict === 'inconclusive'
            ? {}
            : { variant: overrides.variant ?? treatment }),
          rationale: 'stubbed analysis',
        },
        calibration: {
          profile: input.analysis.calibrationProfile,
          note: 'stubbed; not calibrated',
        },
        sessionsAnalyzed: 4,
        computedAt: new Date().toISOString(),
        engine: { name: 'stub-stats', version: '0' },
        kind: 'model',
        assumptions: ['stubbed analysis; nothing was simulated'],
        requirementsDigest: input.analysis.requirementsDigest,
      };
    },
    async allocate(scores: SquadScoreInput[], options = {}) {
      const floor = options.floor ?? 0.1;
      const n = scores.length;
      if (n === 0) return {};
      const weights = scores.map((s) => (s.wins + 1) / (s.runs + 2));
      const total = weights.reduce((a, b) => a + b, 0);
      const free = 1 - floor * n;
      return Object.fromEntries(
        scores.map((s, i) => [s.squad, floor + (free * (weights[i] ?? 0)) / total]),
      );
    },
  };
}

/**
 * Starts a full server (API + real pg-boss worker) against `agon_server_test` with fakes for the
 * model, the browser and (by default) the stats engine. Requests go straight to the Hono app.
 */
export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const databaseUrl = await ensureTestDatabase();
  const dataDir = mkdtempSync(join(tmpdir(), 'agon-server-test-'));
  const server = createServer({
    config: {
      databaseUrl,
      role: options.role ?? 'all',
      bootstrapKeys: options.bootstrapKeys ?? BOOTSTRAP_KEYS,
      dataDir,
      webhookUrl: options.webhookUrl,
      logLevel: 'silent',
      concurrency: 2,
    },
    logger: pino({ level: process.env['AGON_TEST_LOG_LEVEL'] ?? 'silent' }),
    runDependencies: options.runDependencies ?? fakeRunDependencies,
    stats: options.stats ?? stubStats(),
    fetch: options.fetch,
    queuePollingIntervalSeconds: 0.5,
    listen: false,
  });
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  await server.start();
  const request = async (
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<TestResponse> => {
    const headers: Record<string, string> = { ...options.headers };
    const key = options.key === undefined ? KEYS.operator : options.key;
    if (key) headers['authorization'] = `Bearer ${key}`;
    let body: string | undefined;
    if (options.text !== undefined) {
      body = options.text;
      headers['content-type'] = options.contentType ?? 'application/yaml';
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers['content-type'] = options.contentType ?? 'application/json';
    }
    const response = await server.app.request(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    let text: Promise<string> | undefined;
    const readText = (): Promise<string> => (text ??= response.text());
    return {
      status: response.status,
      json: async <T>() => JSON.parse(await readText()) as T,
      text: readText,
      response,
    };
  };
  return {
    server,
    dataDir,
    pool,
    request,
    truncate: async () => {
      await server.context.queue.clear();
      await truncateAll(pool);
    },
    stop: async () => {
      await server.stop();
      await pool.end();
    },
  };
}

/** Suite hooks: one server per file, tables and queue emptied before every test. */
export function useTestServer(options: TestServerOptions = {}): { readonly t: TestServer } {
  let current: TestServer | undefined;
  beforeAll(async () => {
    current = await startTestServer(options);
  });
  beforeEach(async () => {
    await current?.truncate();
  });
  afterAll(async () => {
    await current?.stop();
  });
  return {
    get t() {
      if (!current) throw new Error('the test server is only available inside tests');
      return current;
    },
  };
}

/** Polls until the predicate holds or the timeout passes. */
export async function waitFor<T>(
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  { timeoutMs = 30_000, intervalMs = 200 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await probe();
  while (!done(last)) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting; last value: ${JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await probe();
  }
  return last;
}

export interface LocalHttpServer {
  url: string;
  requests: { method: string; path: string; headers: IncomingMessage['headers']; body: unknown }[];
  close(): Promise<void>;
}

/** A local HTTP server that records every request; `onRequest` may inspect state before replying. */
export async function startLocalHttpServer(
  onRequest?: (
    request: LocalHttpServer['requests'][number],
  ) => Promise<number | void> | number | void,
): Promise<LocalHttpServer> {
  const requests: LocalHttpServer['requests'] = [];
  const server: Server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
      const record = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body };
      requests.push(record);
      Promise.resolve(onRequest?.(record))
        .then((status) => {
          res.writeHead(typeof status === 'number' ? status : 200, {
            'content-type': 'application/json',
          });
          res.end('{"ok":true}');
        })
        .catch(() => {
          res.writeHead(500);
          res.end();
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
