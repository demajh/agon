/**
 * `@agon/sdk`: a typed client for the Agon control-plane API. The transport is `openapi-fetch`
 * over the committed `openapi.json`; the helpers below add the conveniences the CLI, the GitHub
 * Action and the UI share. Nothing here depends on other Agon packages.
 */
import createClient, { type Client, type FetchResponse } from 'openapi-fetch';
import type { components, paths, webhooks } from './generated/types.js';

export type { components, paths, webhooks } from './generated/types.js';

export type Schemas = components['schemas'];
export type AgonConfig = Schemas['AgonConfig'];
export type Environment = Schemas['Environment'];
export type Variant = Schemas['Variant'];
export type VariantSpec = Schemas['VariantSpec'];
export type Run = Schemas['Run'];
export type RunRequest = Schemas['RunRequest'];
export type RunStatus = Run['status'];
export type Session = Schemas['Session'];
export type Step = Schemas['Step'];
export type AgonEvent = Schemas['AgonEvent'];
export type Trace = Schemas['Trace'];
export type Result = Schemas['Result'];
export type Squad = Schemas['Squad'];
export type SquadControlMessage = Schemas['SquadControlMessage'];
export type Decision = Schemas['Decision'];
export type Persona = Schemas['Persona'];
export type ApiKey = Schemas['ApiKey'];
export type LeaderboardEntry = Schemas['LeaderboardEntry'];
export type ErrorResponse = Schemas['ErrorResponse'];
export type WebhookEnvelope = Schemas['WebhookEnvelope'];
export type Health = Schemas['Health'];
export type ValidateConfigResponse = Schemas['ValidateConfigResponse'];
export type RegisterVariantBody = Schemas['RegisterVariantBody'];
export type CreateSquadBody = Schemas['CreateSquadBody'];
export type UpdateSquadBody = Schemas['UpdateSquadBody'];
export type SquadActionBody = Schemas['SquadActionBody'];
export type SquadActionResponse = Schemas['SquadActionResponse'];
export type ReallocateBody = Schemas['ReallocateBody'];
export type ReallocateResponse = Schemas['ReallocateResponse'];
export type CreateApiKeyBody = Schemas['CreateApiKeyBody'];
export type CreatedApiKey = Schemas['CreatedApiKey'];

export type Page<T> = { items: T[]; nextCursor?: string };

/**
 * Request shapes. The generated types mark every field the server defaults as present (that is
 * what responses carry); for requests those fields are optional, so the helpers take these.
 */
export type RunRequestInput = Partial<RunRequest>;
export type VariantSpecInput = Partial<VariantSpec>;
export type RegisterVariantInput = Omit<RegisterVariantBody, 'spec'> & { spec: VariantSpecInput };
/** A parsed config, or any object the server will validate as one. */
export type AgonConfigInput = AgonConfig | Record<string, unknown>;

/** The server's `{ error: { code, message, details } }` envelope, as a thrown error. */
export class AgonApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly url: string;

  constructor(input: {
    status: number;
    code: string;
    message: string;
    details?: unknown;
    url: string;
  }) {
    super(input.message);
    this.name = 'AgonApiError';
    this.status = input.status;
    this.code = input.code;
    this.details = input.details;
    this.url = input.url;
  }
}

/** `runs.wait` gave up before the run reached a terminal status. */
export class AgonTimeoutError extends Error {
  constructor(
    readonly runId: string,
    readonly lastStatus: RunStatus | undefined,
    timeoutMs: number,
  ) {
    super(
      `run ${runId} did not finish within ${timeoutMs} ms (last status: ${lastStatus ?? 'unknown'})`,
    );
    this.name = 'AgonTimeoutError';
  }
}

export interface AgonClientOptions {
  /** e.g. `http://localhost:4000` */
  baseUrl: string;
  /** Sent as `Authorization: Bearer <apiKey>`. Omit for the public meta routes only. */
  apiKey?: string | undefined;
  /** Custom fetch (tests, proxies). Receives a `Request`. */
  fetch?: ((request: Request) => Promise<Response>) | undefined;
  /** Extra headers on every request. */
  headers?: Record<string, string> | undefined;
}

export interface WaitOptions {
  /** Interval between polls (default 2000 ms). */
  pollMs?: number | undefined;
  /** Give up after this long (default 1 hour). */
  timeoutMs?: number | undefined;
  /** Called after every poll with the latest run. */
  onProgress?: ((run: Run) => void) | undefined;
  signal?: AbortSignal | undefined;
}

export interface ListQuery {
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface SessionsQuery extends ListQuery {
  variant?: string | undefined;
  status?: Session['status'] | undefined;
}

export interface RunsQuery extends ListQuery {
  status?: RunStatus | undefined;
}

export interface DecisionsQuery extends ListQuery {
  squadId?: string | undefined;
  status?: Decision['status'] | undefined;
  kind?: Decision['kind'] | undefined;
  policyId?: string | undefined;
  actor?: Decision['actor'] | undefined;
}

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'cancelled'];

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

const YAML_CONTENT_TYPE = 'application/yaml';

function compact<T extends object>(query: T): T {
  return Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined)) as T;
}

type AnyResponse = FetchResponse<Record<string | number, unknown>, unknown, `${string}/${string}`>;

/** Turns an openapi-fetch result into data, or throws `AgonApiError`. */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error === undefined && result.response.ok) return result.data as T;
  const status = result.response.status;
  const url = result.response.url;
  const envelope = result.error as Partial<ErrorResponse> | string | undefined;
  if (
    envelope &&
    typeof envelope === 'object' &&
    envelope.error &&
    typeof envelope.error.code === 'string'
  ) {
    throw new AgonApiError({
      status,
      code: envelope.error.code,
      message: envelope.error.message,
      details: envelope.error.details,
      url,
    });
  }
  throw new AgonApiError({
    status,
    code: 'http_error',
    message: typeof envelope === 'string' && envelope ? envelope.slice(0, 500) : `HTTP ${status}`,
    details: envelope,
    url,
  });
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Builds the client. Every helper throws `AgonApiError` on non-2xx responses. */
export function createAgonClient(options: AgonClientOptions) {
  const headers: Record<string, string> = { ...options.headers };
  if (options.apiKey) headers['authorization'] = `Bearer ${options.apiKey}`;
  const client: Client<paths> = createClient<paths>({
    baseUrl: options.baseUrl.replace(/\/+$/, ''),
    headers,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const path = (id: string) => ({ params: { path: { id } } });
  const yaml = (text: string) => ({
    body: text,
    bodySerializer: (body: unknown) => body as string,
    headers: { 'content-type': YAML_CONTENT_TYPE },
  });

  const environments = {
    /** From a parsed config (JSON) or an `agon.yaml` document (text). Placeholders must be resolved. */
    async create(
      config: AgonConfigInput | string,
      init: { name?: string } = {},
    ): Promise<Environment> {
      if (typeof config === 'string') {
        return unwrap(await client.POST('/v1/environments', yaml(config)));
      }
      return unwrap(
        await client.POST('/v1/environments', {
          body: {
            ...(init.name === undefined ? {} : { name: init.name }),
            config: config as AgonConfig,
          },
        }),
      );
    },
    async get(id: string): Promise<Environment> {
      return unwrap(await client.GET('/v1/environments/{id}', path(id)));
    },
    async list(query: ListQuery & { name?: string | undefined } = {}): Promise<Page<Environment>> {
      return unwrap(await client.GET('/v1/environments', { params: { query: compact(query) } }));
    },
    async replace(
      id: string,
      config: AgonConfigInput | string,
      init: { name?: string } = {},
    ): Promise<Environment> {
      if (typeof config === 'string') {
        return unwrap(await client.PUT('/v1/environments/{id}', { ...path(id), ...yaml(config) }));
      }
      return unwrap(
        await client.PUT('/v1/environments/{id}', {
          ...path(id),
          body: {
            ...(init.name === undefined ? {} : { name: init.name }),
            config: config as AgonConfig,
          },
        }),
      );
    },
    async delete(id: string): Promise<void> {
      unwrap(await client.DELETE('/v1/environments/{id}', path(id)));
    },
    async validate(id: string, config: unknown | string): Promise<ValidateConfigResponse> {
      if (typeof config === 'string') {
        return unwrap(
          await client.POST('/v1/environments/{id}/validate', { ...path(id), ...yaml(config) }),
        );
      }
      return unwrap(
        await client.POST('/v1/environments/{id}/validate', { ...path(id), body: { config } }),
      );
    },
  };

  const variants = {
    async register(environmentId: string, variant: RegisterVariantInput): Promise<Variant> {
      return unwrap(
        await client.POST('/v1/environments/{id}/variants', {
          ...path(environmentId),
          body: variant as RegisterVariantBody,
        }),
      );
    },
    async list(environmentId: string): Promise<Variant[]> {
      return unwrap(await client.GET('/v1/environments/{id}/variants', path(environmentId))).items;
    },
  };

  const runs = {
    async start(environmentId: string, request: RunRequestInput = {}): Promise<Run> {
      return unwrap(
        await client.POST('/v1/environments/{id}/runs', {
          ...path(environmentId),
          body: compact(request) as RunRequest,
        }),
      );
    },
    async get(id: string): Promise<Run> {
      return unwrap(await client.GET('/v1/runs/{id}', path(id)));
    },
    async list(environmentId: string, query: RunsQuery = {}): Promise<Page<Run>> {
      return unwrap(
        await client.GET('/v1/environments/{id}/runs', {
          ...path(environmentId),
          params: { ...path(environmentId).params, query: compact(query) },
        }),
      );
    },
    async cancel(id: string): Promise<Run> {
      return unwrap(await client.POST('/v1/runs/{id}/cancel', path(id)));
    },
    /** Resolves once the run is `completed`, `failed` or `cancelled`. */
    async wait(id: string, waitOptions: WaitOptions = {}): Promise<Run> {
      const pollMs = waitOptions.pollMs ?? 2_000;
      const timeoutMs = waitOptions.timeoutMs ?? 3_600_000;
      const deadline = Date.now() + timeoutMs;
      let last: Run | undefined;
      for (;;) {
        last = await runs.get(id);
        waitOptions.onProgress?.(last);
        if (isTerminal(last.status)) return last;
        if (Date.now() + pollMs > deadline) throw new AgonTimeoutError(id, last.status, timeoutMs);
        await sleep(pollMs, waitOptions.signal);
      }
    },
    /** The analysis; 404 (`not_found`) until the run has completed. */
    async result(id: string): Promise<Result> {
      // openapi-fetch's response mapping widens the `ci95` tuples to arrays; the document has tuples.
      return unwrap(await client.GET('/v1/runs/{id}/results', path(id))) as unknown as Result;
    },
    async sessions(id: string, query: SessionsQuery = {}): Promise<Page<Session>> {
      return unwrap(
        await client.GET('/v1/runs/{id}/sessions', {
          params: { path: { id }, query: compact(query) },
        }),
      );
    },
    /** Every session of the run, following pagination. */
    async allSessions(id: string, query: Omit<SessionsQuery, 'cursor'> = {}): Promise<Session[]> {
      const out: Session[] = [];
      let cursor: string | undefined;
      do {
        const page = await runs.sessions(id, { ...query, cursor });
        out.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      return out;
    },
    /** PNG bytes of the screenshot taken at a step. */
    async screenshot(runId: string, stepId: string): Promise<Uint8Array> {
      const result = await client.GET('/v1/runs/{id}/screenshots/{stepId}', {
        params: { path: { id: runId, stepId } },
        parseAs: 'arrayBuffer',
      });
      const data = unwrap(result as AnyResponse);
      return new Uint8Array(data as ArrayBuffer);
    },
  };

  const sessions = {
    async get(id: string): Promise<Session> {
      return unwrap(await client.GET('/v1/sessions/{id}', path(id)));
    },
    async trace(id: string): Promise<Trace> {
      return unwrap(await client.GET('/v1/sessions/{id}/trace', path(id)));
    },
  };

  const personas = {
    async list(): Promise<Persona[]> {
      return unwrap(await client.GET('/v1/personas')).items;
    },
  };

  const squads = {
    async create(squad: CreateSquadBody): Promise<Squad> {
      return unwrap(await client.POST('/v1/squads', { body: squad }));
    },
    async list(query: { status?: Squad['status'] | undefined } = {}): Promise<Squad[]> {
      return unwrap(await client.GET('/v1/squads', { params: { query: compact(query) } })).items;
    },
    async get(id: string): Promise<Squad> {
      return unwrap(await client.GET('/v1/squads/{id}', path(id)));
    },
    async update(id: string, patch: UpdateSquadBody): Promise<Squad> {
      return unwrap(await client.PATCH('/v1/squads/{id}', { ...path(id), body: patch }));
    },
    async leaderboard(): Promise<LeaderboardEntry[]> {
      return unwrap(await client.GET('/v1/squads/leaderboard')).items;
    },
    async pause(id: string, body: SquadActionBody): Promise<SquadActionResponse> {
      return unwrap(await client.POST('/v1/squads/{id}/pause', { ...path(id), body }));
    },
    async resume(id: string, body: SquadActionBody): Promise<SquadActionResponse> {
      return unwrap(await client.POST('/v1/squads/{id}/resume', { ...path(id), body }));
    },
    async kill(id: string, body: SquadActionBody): Promise<SquadActionResponse> {
      return unwrap(await client.POST('/v1/squads/{id}/kill', { ...path(id), body }));
    },
    async reallocate(body: ReallocateBody = {}): Promise<ReallocateResponse> {
      return unwrap(await client.POST('/v1/squads/reallocate', { body }));
    },
  };

  const decisions = {
    async list(query: DecisionsQuery = {}): Promise<Page<Decision>> {
      return unwrap(await client.GET('/v1/decisions', { params: { query: compact(query) } }));
    },
    async get(id: string): Promise<Decision> {
      return unwrap(await client.GET('/v1/decisions/{id}', path(id)));
    },
    async approve(id: string): Promise<Decision> {
      return unwrap(await client.POST('/v1/decisions/{id}/approve', path(id)));
    },
    async reject(id: string): Promise<Decision> {
      return unwrap(await client.POST('/v1/decisions/{id}/reject', path(id)));
    },
  };

  const apiKeys = {
    async create(body: CreateApiKeyBody): Promise<CreatedApiKey> {
      return unwrap(await client.POST('/v1/api-keys', { body }));
    },
    async list(): Promise<ApiKey[]> {
      return unwrap(await client.GET('/v1/api-keys')).items;
    },
    async revoke(id: string): Promise<ApiKey> {
      return unwrap(await client.DELETE('/v1/api-keys/{id}', path(id)));
    },
  };

  return {
    /** The raw openapi-fetch client, for anything the helpers do not cover. */
    client,
    async health(): Promise<Health> {
      return unwrap(await client.GET('/healthz'));
    },
    environments,
    variants,
    runs,
    sessions,
    personas,
    squads,
    decisions,
    apiKeys,
  };
}

export type AgonClient = ReturnType<typeof createAgonClient>;
