import { describe, expect, it } from 'vitest';
import { AgonApiError, AgonTimeoutError, createAgonClient, isTerminal, unwrap } from './index.js';

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

type Responder = (request: Recorded, index: number) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stub(responder: Responder) {
  const calls: Recorded[] = [];
  const fetch = async (request: Request): Promise<Response> => {
    const recorded: Recorded = {
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers.entries()),
      body: await request.text(),
    };
    calls.push(recorded);
    return responder(recorded, calls.length - 1);
  };
  return { calls, fetch };
}

const run = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 'run_1',
  environmentId: 'env_1',
  status,
  variants: ['control', 'treatment'],
  seed: 7,
  config: {},
  counts: { planned: 4, running: 0, completed: 0, failed: 0 },
  costUsd: 0,
  createdAt: '2026-10-04T17:00:00.000Z',
  ...extra,
});

describe('createAgonClient', () => {
  it('sends the bearer key, JSON bodies and path parameters', async () => {
    const s = stub(() => json({ id: 'env_1' }, 201));
    const agon = createAgonClient({
      baseUrl: 'http://agon.test/',
      apiKey: 'secret-key',
      fetch: s.fetch,
    });
    const env = await agon.environments.create({ version: 1, name: 'x' } as never, {
      name: 'custom',
    });
    expect(env).toEqual({ id: 'env_1' });
    expect(s.calls[0]).toMatchObject({ method: 'POST', url: 'http://agon.test/v1/environments' });
    expect(s.calls[0]!.headers['authorization']).toBe('Bearer secret-key');
    expect(s.calls[0]!.headers['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(s.calls[0]!.body)).toEqual({
      name: 'custom',
      config: { version: 1, name: 'x' },
    });

    await agon.runs.get('run_42');
    expect(s.calls[1]).toMatchObject({
      method: 'GET',
      url: 'http://agon.test/v1/runs/run_42',
      body: '',
    });
    await agon.runs.screenshot('run_42', 'stp_1').catch(() => undefined);
    expect(s.calls[2]!.url).toBe('http://agon.test/v1/runs/run_42/screenshots/stp_1');
  });

  it('uploads YAML as text with the YAML content type', async () => {
    const s = stub(() => json({ id: 'env_1' }, 201));
    const agon = createAgonClient({ baseUrl: 'http://agon.test', apiKey: 'k', fetch: s.fetch });
    await agon.environments.create('version: 1\nname: y\n');
    expect(s.calls[0]!.headers['content-type']).toBe('application/yaml');
    expect(s.calls[0]!.body).toBe('version: 1\nname: y\n');
    await agon.environments.validate('env_1', 'version: 1\n');
    expect(s.calls[1]).toMatchObject({
      method: 'POST',
      url: 'http://agon.test/v1/environments/env_1/validate',
    });
    await agon.environments.validate('env_1', { version: 1 });
    expect(JSON.parse(s.calls[2]!.body)).toEqual({ config: { version: 1 } });
    await agon.environments.replace('env_1', 'version: 1\n');
    expect(s.calls[3]).toMatchObject({ method: 'PUT', body: 'version: 1\n' });
  });

  it('serialises query parameters and drops undefined ones', async () => {
    const s = stub(() => json({ items: [] }));
    const agon = createAgonClient({ baseUrl: 'http://agon.test', apiKey: 'k', fetch: s.fetch });
    await agon.runs.sessions('run_1', { variant: 'treatment', limit: 10, status: undefined });
    const url = new URL(s.calls[0]!.url);
    expect(url.pathname).toBe('/v1/runs/run_1/sessions');
    expect(url.searchParams.get('variant')).toBe('treatment');
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.has('status')).toBe(false);
    await agon.decisions.list({ squadId: 'sqd_1', status: 'proposed' });
    expect(new URL(s.calls[1]!.url).search).toBe('?squadId=sqd_1&status=proposed');
    await agon.squads.list();
    expect(new URL(s.calls[2]!.url).search).toBe('');
  });

  it('maps error envelopes to AgonApiError and keeps the status', async () => {
    const s = stub(() =>
      json(
        {
          error: {
            code: 'not_found',
            message: 'run not found: run_9',
            details: { resource: 'run', id: 'run_9' },
          },
        },
        404,
      ),
    );
    const agon = createAgonClient({ baseUrl: 'http://agon.test', apiKey: 'k', fetch: s.fetch });
    const error = await agon.runs.result('run_9').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgonApiError);
    expect(error).toMatchObject({
      status: 404,
      code: 'not_found',
      message: 'run not found: run_9',
      details: { resource: 'run', id: 'run_9' },
    });
    expect(typeof (error as AgonApiError).url).toBe('string');
  });

  it('wraps non-envelope failures too', async () => {
    const s = stub(
      () =>
        new Response('<html>bad gateway</html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const agon = createAgonClient({ baseUrl: 'http://agon.test', apiKey: 'k', fetch: s.fetch });
    const error = await agon.health().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgonApiError);
    expect(error).toMatchObject({ status: 502, code: 'http_error' });
    expect((error as AgonApiError).message).toContain('bad gateway');
    expect(() =>
      unwrap({ error: undefined, response: new Response(null, { status: 500 }) }),
    ).toThrow(AgonApiError);
  });

  it('unwraps the items of list endpoints and 204 deletes', async () => {
    const s = stub((request) =>
      request.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : json({ items: [{ id: 'p' }] }),
    );
    const agon = createAgonClient({ baseUrl: 'http://agon.test', apiKey: 'k', fetch: s.fetch });
    expect(await agon.personas.list()).toEqual([{ id: 'p' }]);
    expect(await agon.variants.list('env_1')).toEqual([{ id: 'p' }]);
    await expect(agon.environments.delete('env_1')).resolves.toBeUndefined();
    expect(s.calls[2]).toMatchObject({
      method: 'DELETE',
      url: 'http://agon.test/v1/environments/env_1',
    });
  });

  it('follows pagination in allSessions', async () => {
    const s = stub((request) => {
      const cursor = new URL(request.url).searchParams.get('cursor');
      return cursor === null
        ? json({ items: [{ id: 'ses_1' }, { id: 'ses_2' }], nextCursor: 'c2' })
        : json({ items: [{ id: 'ses_3' }] });
    });
    const agon = createAgonClient({ baseUrl: 'http://agon.test', apiKey: 'k', fetch: s.fetch });
    const all = await agon.runs.allSessions('run_1', { variant: 'control' });
    expect(all.map((x) => x.id)).toEqual(['ses_1', 'ses_2', 'ses_3']);
    expect(s.calls).toHaveLength(2);
    expect(new URL(s.calls[1]!.url).searchParams.get('cursor')).toBe('c2');
    expect(new URL(s.calls[1]!.url).searchParams.get('variant')).toBe('control');
  });

  it('polls runs.wait until a terminal status and reports progress', async () => {
    const statuses = ['queued', 'running', 'running', 'completed'];
    const s = stub((_request, i) =>
      json(
        run(statuses[Math.min(i, statuses.length - 1)]!, {
          resultId: i >= 3 ? 'res_1' : undefined,
        }),
      ),
    );
    const agon = createAgonClient({ baseUrl: 'http://agon.test', apiKey: 'k', fetch: s.fetch });
    const seen: string[] = [];
    const final = await agon.runs.wait('run_1', {
      pollMs: 5,
      onProgress: (r) => seen.push(r.status),
    });
    expect(final.status).toBe('completed');
    expect(final.resultId).toBe('res_1');
    expect(seen).toEqual(['queued', 'running', 'running', 'completed']);
    expect(s.calls).toHaveLength(4);
    expect(s.calls.every((c) => c.url === 'http://agon.test/v1/runs/run_1')).toBe(true);
  });

  it('times out, aborts, and surfaces API errors while waiting', async () => {
    const forever = stub(() => json(run('running')));
    const agon = createAgonClient({
      baseUrl: 'http://agon.test',
      apiKey: 'k',
      fetch: forever.fetch,
    });
    const timeout = await agon.runs
      .wait('run_1', { pollMs: 5, timeoutMs: 20 })
      .catch((e: unknown) => e);
    expect(timeout).toBeInstanceOf(AgonTimeoutError);
    expect(timeout).toMatchObject({ runId: 'run_1', lastStatus: 'running' });

    const controller = new AbortController();
    const waiting = agon.runs.wait('run_1', { pollMs: 1_000, signal: controller.signal });
    controller.abort(new Error('stop'));
    await expect(waiting).rejects.toThrow('stop');

    const failing = stub(() => json({ error: { code: 'unauthorized', message: 'nope' } }, 401));
    const unauthorized = createAgonClient({ baseUrl: 'http://agon.test', fetch: failing.fetch });
    await expect(unauthorized.runs.wait('run_1', { pollMs: 1 })).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    });
    expect(failing.calls[0]!.headers['authorization']).toBeUndefined();
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('running')).toBe(false);
  });

  it('exposes squad governance helpers with the right routes', async () => {
    const s = stub(() => json({ squad: { id: 'sqd_1' }, decision: { id: 'dec_1' } }));
    const agon = createAgonClient({ baseUrl: 'http://agon.test', apiKey: 'k', fetch: s.fetch });
    await agon.squads.pause('sqd_1', { reason: 'r' });
    await agon.squads.kill('sqd_1', { reason: 'r', approval: 'human' });
    await agon.squads.reallocate({ floor: 0.2 });
    await agon.decisions.approve('dec_1');
    await agon.apiKeys.create({ role: 'observer', label: 'ci' });
    expect(s.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /v1/squads/sqd_1/pause',
      'POST /v1/squads/sqd_1/kill',
      'POST /v1/squads/reallocate',
      'POST /v1/decisions/dec_1/approve',
      'POST /v1/api-keys',
    ]);
    expect(JSON.parse(s.calls[1]!.body)).toEqual({ reason: 'r', approval: 'human' });
    expect(JSON.parse(s.calls[2]!.body)).toEqual({ floor: 0.2 });
  });
});
