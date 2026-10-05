import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';
import { ActionSchema, AdapterError, INFERRED_EVENTS, ObservationSchema, nowIso } from '@agon/spec';
import type {
  ActResult,
  Action,
  AdapterSession,
  EventDraft,
  ObserveOptions,
  Observation,
  TargetKind,
} from '@agon/spec';
import { shortErrorMessage } from '../web/actions.js';
import { cutText } from '../web/observe.js';
import {
  catalogHash,
  catalogInteractive,
  clipText,
  renderCallToolResult,
  renderGetPromptResult,
  renderObservationText,
  renderReadResourceResult,
} from './catalog.js';
import type {
  McpCatalog,
  McpLastCall,
  McpPromptEntry,
  McpResourceEntry,
  McpToolEntry,
} from './catalog.js';

/** The catalog is the whole user interface of an MCP server, so the caps are generous. */
export const DEFAULT_MCP_MAX_TEXT_CHARS = 12_000;
export const DEFAULT_MCP_MAX_INTERACTIVE = 100;

const MAX_BUFFERED_EVENTS = 5000;
const MAX_PENDING_ERRORS = 50;
const MAX_LIST_PAGES = 50;
const MAX_ERROR_CHARS = 500;

type CatalogKind = keyof McpCatalog;
const REF_PREFIX: Readonly<Record<CatalogKind, string>> = {
  tools: 't',
  resources: 'r',
  prompts: 'p',
};

export interface McpSessionOptions {
  /** A connected client; the session owns it from here on and closes it. */
  client: Client;
  /** Observation url. Defaults to `mcp://<server name>` for transports without one. */
  url?: string;
  /** Timeout for every request to the server (list, call, read, get). */
  callTimeoutMs: number;
  /** Cap on the stored and shown text of the last result. */
  maxResultChars: number;
  /** Called once the session has closed, however that happened. */
  onClose?: () => void;
}

interface Page<T> {
  items: T[];
  nextCursor?: string | undefined;
}

async function paginate<T>(
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const result = await fetchPage(cursor);
    items.push(...result.items);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return items;
}

function positiveInt(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : undefined;
}

/** The whole error message on one line, cut to `max`; servers put the useful part anywhere. */
function flatErrorMessage(error: unknown, max: number): string {
  const message = error instanceof Error ? error.message : String(error);
  const flat = message.replace(/\s*\n\s*/g, ' ').trim();
  return clipText(flat === '' ? 'unknown error' : flat, max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One MCP client connection, presented as an `AdapterSession`: the observation is the catalog of
 * tools, resources and prompts plus the outcome of the last call; the actions are tool calls,
 * resource reads (click / navigate) and prompt fetches (click).
 */
export class McpSession implements AdapterSession {
  readonly kind: TargetKind = 'mcp';

  private readonly client: Client;
  private readonly url: string;
  private readonly title: string;
  private readonly capabilities: ServerCapabilities;
  private readonly callTimeoutMs: number;
  private readonly maxResultChars: number;
  private readonly onClose: (() => void) | undefined;
  private readonly refs: Record<CatalogKind, Map<string, string>> = {
    tools: new Map(),
    resources: new Map(),
    prompts: new Map(),
  };
  private readonly counters: Record<CatalogKind, number> = { tools: 0, resources: 0, prompts: 0 };
  private catalog: McpCatalog = { tools: [], resources: [], prompts: [] };
  private last: McpLastCall | undefined;
  private readonly events: EventDraft[] = [];
  private readonly pendingErrors: string[] = [];
  private closed = false;
  private closing = false;
  private closeReason: string | undefined;

  constructor(options: McpSessionOptions) {
    this.client = options.client;
    this.callTimeoutMs = options.callTimeoutMs;
    this.maxResultChars = options.maxResultChars;
    this.onClose = options.onClose;
    const info = this.client.getServerVersion();
    const name = info?.name.trim() || 'server';
    this.title = info ? `${name} ${info.version}`.trim() : name;
    this.url = options.url ?? `mcp://${name.replace(/\s+/g, '-')}`;
    this.capabilities = this.client.getServerCapabilities() ?? {};
    this.client.onerror = (error: Error) => {
      this.pushError(`transport error: ${shortErrorMessage(error, 300)}`);
    };
    this.client.onclose = () => {
      if (this.closing) return;
      this.closed = true;
      this.closeReason = 'the server closed the connection';
      this.onClose?.();
    };
  }

  // -------------------------------------------------------------------------
  // AdapterSession
  // -------------------------------------------------------------------------

  async observe(options: ObserveOptions = {}): Promise<Observation> {
    this.assertUsable();
    const maxInteractive = positiveInt(options.maxInteractive) ?? DEFAULT_MCP_MAX_INTERACTIVE;
    const maxTextChars = positiveInt(options.maxTextChars) ?? DEFAULT_MCP_MAX_TEXT_CHARS;
    await this.refreshCatalog();
    const fullText = renderObservationText(this.catalog, this.last);
    const text = cutText(fullText, maxTextChars);
    const all = catalogInteractive(this.catalog);
    const interactive = all.slice(0, maxInteractive);
    return ObservationSchema.parse({
      url: this.url,
      title: this.title,
      text,
      interactive,
      errors: this.pendingErrors.splice(0),
      truncated: text.length < fullText.length || interactive.length < all.length,
      hash: catalogHash(this.catalog, this.last),
      capturedAt: nowIso(),
    });
  }

  async act(action: Action): Promise<ActResult> {
    this.assertUsable();
    const parsed = ActionSchema.safeParse(action);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((issue) => issue.message).join('; ');
      return { ok: false, error: clipText(`invalid action: ${detail}`, 200), navigated: false };
    }
    try {
      const error = await this.perform(parsed.data);
      return error === undefined
        ? { ok: true, navigated: false }
        : { ok: false, error, navigated: false };
    } catch (error) {
      this.rethrowIfGone(error);
      return { ok: false, error: flatErrorMessage(error, MAX_ERROR_CHARS), navigated: false };
    }
  }

  drainEvents(): EventDraft[] {
    return this.events.splice(0);
  }

  /** MCP servers have nothing to look at. */
  async screenshot(): Promise<Uint8Array | undefined> {
    return undefined;
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const wasClosed = this.closed;
    this.closed = true;
    await this.client.close().catch(() => undefined);
    if (!wasClosed) this.onClose?.();
  }

  // -------------------------------------------------------------------------
  // Catalog
  // -------------------------------------------------------------------------

  /**
   * Re-lists tools, resources and prompts (only the kinds the server advertises). Refs are keyed
   * by name, so they survive re-listing and new entries get fresh refs; a kind whose listing fails
   * keeps its previous entries and the failure shows up in `errors`.
   */
  private async refreshCatalog(): Promise<void> {
    const [tools, resources, prompts] = await Promise.all([
      this.listSection('tools', () => this.listTools()),
      this.listSection('resources', () => this.listResources()),
      this.listSection('prompts', () => this.listPrompts()),
    ]);
    this.catalog = {
      tools: tools ?? this.catalog.tools,
      resources: resources ?? this.catalog.resources,
      prompts: prompts ?? this.catalog.prompts,
    };
  }

  private async listSection<T>(
    kind: CatalogKind,
    list: () => Promise<T[]>,
  ): Promise<T[] | undefined> {
    if (this.capabilities[kind] === undefined) return [];
    try {
      return await list();
    } catch (error) {
      this.rethrowIfGone(error);
      this.pushError(`listing ${kind} failed: ${flatErrorMessage(error, 300)}`);
      return undefined;
    }
  }

  private async listTools(): Promise<McpToolEntry[]> {
    const tools = await paginate(async (cursor) => {
      const result = await this.client.listTools(
        cursor === undefined ? undefined : { cursor },
        this.requestOptions(),
      );
      return { items: result.tools, nextCursor: result.nextCursor };
    });
    return tools.map((tool) => ({
      ref: this.refFor('tools', tool.name),
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    }));
  }

  private async listResources(): Promise<McpResourceEntry[]> {
    const resources = await paginate(async (cursor) => {
      const result = await this.client.listResources(
        cursor === undefined ? undefined : { cursor },
        this.requestOptions(),
      );
      return { items: result.resources, nextCursor: result.nextCursor };
    });
    return resources.map((resource) => ({
      ref: this.refFor('resources', resource.uri),
      uri: resource.uri,
      name: resource.name,
      title: resource.title,
      description: resource.description,
      mimeType: resource.mimeType,
    }));
  }

  private async listPrompts(): Promise<McpPromptEntry[]> {
    const prompts = await paginate(async (cursor) => {
      const result = await this.client.listPrompts(
        cursor === undefined ? undefined : { cursor },
        this.requestOptions(),
      );
      return { items: result.prompts, nextCursor: result.nextCursor };
    });
    return prompts.map((prompt) => ({
      ref: this.refFor('prompts', prompt.name),
      name: prompt.name,
      title: prompt.title,
      description: prompt.description,
      arguments: prompt.arguments?.map((argument) => ({
        name: argument.name,
        description: argument.description,
        required: argument.required,
      })),
    }));
  }

  private refFor(kind: CatalogKind, key: string): string {
    const existing = this.refs[kind].get(key);
    if (existing !== undefined) return existing;
    this.counters[kind] += 1;
    const ref = `${REF_PREFIX[kind]}${this.counters[kind]}`;
    this.refs[kind].set(key, ref);
    return ref;
  }

  private requestOptions(): { timeout: number } {
    return { timeout: this.callTimeoutMs };
  }

  // -------------------------------------------------------------------------
  // Actions. Each returns an error message for a failed-but-recoverable action, undefined on
  // success. Anything thrown is turned into ok:false by `act`, unless the session is gone.
  // -------------------------------------------------------------------------

  private async perform(action: Action): Promise<string | undefined> {
    switch (action.type) {
      case 'tool_call':
        return this.callTool(action.ref, action.arguments);
      case 'click':
        return this.click(action.ref);
      case 'navigate':
        return this.navigate(action.url);
      case 'wait':
        await sleep(action.ms);
        return undefined;
      case 'done':
      case 'give_up':
        return undefined;
      case 'fill':
      case 'select':
      case 'press':
      case 'scroll':
      case 'back':
        return `${action.type} is not applicable to an MCP server; use tool_call with arguments, or click a resource or prompt`;
    }
  }

  private async callTool(ref: string, args: Record<string, unknown>): Promise<string | undefined> {
    const tool = this.catalog.tools.find((entry) => entry.ref === ref);
    if (!tool) {
      return `no such ref "${ref}"; tool refs look like t3 and come from the latest observation`;
    }
    const startedAt = Date.now();
    let text: string;
    let isError: boolean;
    try {
      const result = await this.client.callTool(
        { name: tool.name, arguments: args },
        undefined,
        this.requestOptions(),
      );
      text = renderCallToolResult(result);
      isError = 'isError' in result && result.isError === true;
    } catch (error) {
      this.rethrowIfGone(error);
      const message = flatErrorMessage(error, MAX_ERROR_CHARS);
      this.recordToolCall(tool.name, args, startedAt, true, 0);
      this.recordToolError(tool.name, message);
      return message;
    }
    this.recordToolCall(tool.name, args, startedAt, isError, text.length);
    if (isError) {
      const message = text.trim() === '' ? 'the tool reported an error without a message' : text;
      this.recordToolError(tool.name, clipText(message, MAX_ERROR_CHARS));
      return clipText(message, MAX_ERROR_CHARS);
    }
    this.last = {
      kind: 'result',
      what: `tool ${tool.name}`,
      text: clipText(text, this.maxResultChars),
    };
    return undefined;
  }

  private async click(ref: string): Promise<string | undefined> {
    const tool = this.catalog.tools.find((entry) => entry.ref === ref);
    if (tool) return `${ref} is a tool; use tool_call with arguments`;
    const resource = this.catalog.resources.find((entry) => entry.ref === ref);
    if (resource) return this.readResource(resource.uri);
    const prompt = this.catalog.prompts.find((entry) => entry.ref === ref);
    if (prompt) return this.getPrompt(prompt.name);
    return `no such ref "${ref}"; refs come from the latest observation`;
  }

  private async navigate(target: string): Promise<string | undefined> {
    const uri = target.trim();
    const resource = this.catalog.resources.find((entry) => entry.uri === uri);
    if (!resource) {
      return `"${target}" is not a resource listed in the observation; navigate can only read listed resource uris`;
    }
    return this.readResource(resource.uri);
  }

  private async readResource(uri: string): Promise<string | undefined> {
    const what = `resource ${uri}`;
    try {
      const result = await this.client.readResource({ uri }, this.requestOptions());
      this.last = {
        kind: 'result',
        what,
        text: clipText(renderReadResourceResult(result), this.maxResultChars),
      };
      return undefined;
    } catch (error) {
      this.rethrowIfGone(error);
      return this.recordFailure(what, flatErrorMessage(error, MAX_ERROR_CHARS));
    }
  }

  private async getPrompt(name: string): Promise<string | undefined> {
    const what = `prompt ${name}`;
    try {
      const result = await this.client.getPrompt({ name }, this.requestOptions());
      this.last = {
        kind: 'result',
        what,
        text: clipText(renderGetPromptResult(result), this.maxResultChars),
      };
      return undefined;
    } catch (error) {
      this.rethrowIfGone(error);
      return this.recordFailure(what, flatErrorMessage(error, MAX_ERROR_CHARS));
    }
  }

  // -------------------------------------------------------------------------
  // Events and errors
  // -------------------------------------------------------------------------

  private recordToolCall(
    tool: string,
    args: Record<string, unknown>,
    startedAt: number,
    isError: boolean,
    resultChars: number,
  ): void {
    this.pushEvent({
      timestamp: nowIso(),
      event: INFERRED_EVENTS.toolCall,
      source: 'inferred',
      properties: {
        tool,
        arguments: args,
        duration_ms: Date.now() - startedAt,
        is_error: isError,
        result_chars: resultChars,
      },
    });
  }

  private recordToolError(tool: string, error: string): void {
    this.pushEvent({
      timestamp: nowIso(),
      event: INFERRED_EVENTS.toolError,
      source: 'inferred',
      properties: { tool, error },
    });
    this.recordFailure(`tool ${tool}`, error);
  }

  /** Remembers a failed call for the next observation and returns the message for `ActResult`. */
  private recordFailure(what: string, message: string): string {
    this.last = { kind: 'error', what, text: clipText(message, this.maxResultChars) };
    this.pushError(`${what} failed: ${message}`);
    return message;
  }

  private pushEvent(draft: EventDraft): void {
    if (this.events.length >= MAX_BUFFERED_EVENTS) this.events.shift();
    this.events.push(draft);
  }

  private pushError(message: string): void {
    if (this.pendingErrors.length < MAX_PENDING_ERRORS) {
      this.pendingErrors.push(clipText(message, MAX_ERROR_CHARS));
    } else if (this.pendingErrors.length === MAX_PENDING_ERRORS) {
      this.pendingErrors.push('… further errors omitted');
    }
  }

  // -------------------------------------------------------------------------
  // Liveness
  // -------------------------------------------------------------------------

  private assertUsable(): void {
    if (!this.closed) return;
    throw new AdapterError(
      `mcp session is closed${this.closeReason ? `: ${this.closeReason}` : ''}`,
    );
  }

  /** Converts "the connection is gone" failures into AdapterError; returns otherwise. */
  private rethrowIfGone(error: unknown): void {
    const connectionLost =
      (error instanceof McpError && error.code === ErrorCode.ConnectionClosed) ||
      (error instanceof Error && /not connected/i.test(error.message));
    if (!this.closed && !connectionLost) return;
    if (!this.closed) {
      this.closed = true;
      this.closeReason = 'the connection was lost';
      this.onClose?.();
    }
    throw new AdapterError(`mcp session is no longer available: ${shortErrorMessage(error, 160)}`, {
      cause: error,
    });
  }
}
