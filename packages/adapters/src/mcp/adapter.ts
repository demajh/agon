import type { Stream } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Implementation } from '@modelcontextprotocol/sdk/types.js';
import { AdapterError } from '@agon/spec';
import type { Adapter, AdapterSession, OpenOptions, VariantSpec } from '@agon/spec';
import { shortErrorMessage } from '../web/actions.js';
import { parseCommand } from './command.js';
import { McpSession } from './session.js';

export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RESULT_CHARS = 8_000;

/** How Agon introduces itself in the MCP `initialize` handshake. */
export const MCP_CLIENT_INFO: Implementation = {
  name: 'agon',
  version: '0.0.1',
  title: 'Agon simulated agent',
};

const STDERR_TAIL_CHARS = 2000;

/** Produces the transport for one session; lets tests inject an `InMemoryTransport`. */
export type McpConnect = (variant: VariantSpec, options: OpenOptions) => Promise<Transport>;

export interface McpAdapterOptions {
  /** Deadline for spawning / reaching the server and finishing `initialize`. Default 15 s. */
  connectTimeoutMs?: number;
  /** Timeout for every request once connected (tool calls, listings, reads). Default 60 s. */
  callTimeoutMs?: number;
  /** Cap on the last result text kept and shown in the observation. Default 8000. */
  maxResultChars?: number;
  /** Replaces the transport selection (stdio / streamable http / sse) entirely. */
  connect?: McpConnect;
  /** Client identity sent to the server. Default `MCP_CLIENT_INFO`. */
  clientInfo?: Implementation;
}

export interface McpAdapter extends Adapter {
  readonly kind: 'mcp';
  /** Closes every session this adapter opened. */
  dispose(): Promise<void>;
}

const noop = (): undefined => undefined;

/** Keeps the last few kilobytes a child wrote to stderr, for the error when it fails to start. */
class StderrTail {
  private text = '';

  constructor(stream: Stream | null) {
    stream?.on('data', (chunk: unknown) => {
      this.text = `${this.text}${String(chunk)}`.slice(-STDERR_TAIL_CHARS);
    });
  }

  tail(): string {
    return this.text.replace(/\s+/g, ' ').trim();
  }
}

/**
 * Connects a fresh client over `transport`, bounded by `timeoutMs` for the whole handshake
 * (the SDK's own request timeout only covers `initialize`, not a transport that never starts).
 * On failure the client, and with it the transport, is closed before the error propagates.
 */
async function connectClient(
  transport: Transport,
  clientInfo: Implementation,
  timeoutMs: number,
): Promise<Client> {
  const client = new Client(clientInfo, { capabilities: {} });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${timeoutMs} ms waiting for initialize`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([client.connect(transport, { timeout: timeoutMs }), deadline]);
    return client;
  } catch (error) {
    await client.close().catch(noop);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A 4xx from the Streamable HTTP endpoint: the server may only speak the older SSE transport. */
function isHttpRejection(error: unknown): boolean {
  return (
    error instanceof StreamableHTTPError &&
    typeof error.code === 'number' &&
    error.code >= 400 &&
    error.code < 500
  );
}

/**
 * The MCP adapter: Agon connects to a Model Context Protocol server as a client so simulated
 * agent personas can be run against it. `variant.url` connects over Streamable HTTP, falling
 * back to the legacy SSE transport when the server rejects it; `variant.command` spawns the
 * server over stdio with `variant.env` and the session credentials in its environment.
 */
export function createMcpAdapter(options: McpAdapterOptions = {}): McpAdapter {
  const defaultConnectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const maxResultChars = options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const clientInfo = options.clientInfo ?? MCP_CLIENT_INFO;
  const sessions = new Set<McpSession>();

  async function openInjected(
    connect: McpConnect,
    variant: VariantSpec,
    openOptions: OpenOptions,
    timeoutMs: number,
  ): Promise<Client> {
    let transport: Transport;
    try {
      transport = await connect(variant, openOptions);
    } catch (error) {
      throw new AdapterError(`failed to create mcp transport: ${shortErrorMessage(error, 200)}`, {
        cause: error,
        details: { variant: openOptions.variant },
      });
    }
    try {
      return await connectClient(transport, clientInfo, timeoutMs);
    } catch (error) {
      throw new AdapterError(`failed to connect to mcp server: ${shortErrorMessage(error, 200)}`, {
        cause: error,
        details: { variant: openOptions.variant },
      });
    }
  }

  async function openStdio(
    command: string,
    variant: VariantSpec,
    openOptions: OpenOptions,
    timeoutMs: number,
  ): Promise<Client> {
    const details = { variant: openOptions.variant, command };
    let argv: string[];
    try {
      argv = parseCommand(command);
    } catch (error) {
      throw new AdapterError(`invalid variant.command: ${shortErrorMessage(error)}`, {
        cause: error,
        details,
      });
    }
    const [executable, ...args] = argv;
    if (executable === undefined) {
      throw new AdapterError('variant.command is empty', { details });
    }
    const transport = new StdioClientTransport({
      command: executable,
      args,
      env: { ...variant.env, ...openOptions.credentials },
      stderr: 'pipe',
    });
    // Keeps the child's stderr flowing for the life of the process and remembers its tail.
    const stderr = new StderrTail(transport.stderr);
    try {
      return await connectClient(transport, clientInfo, timeoutMs);
    } catch (error) {
      const tail = stderr.tail();
      throw new AdapterError(
        `failed to start mcp server "${command}": ${shortErrorMessage(error, 200)}${
          tail ? ` (stderr: ${tail})` : ''
        }`,
        { cause: error, details },
      );
    }
  }

  async function openHttp(
    rawUrl: string,
    headers: Record<string, string>,
    openOptions: OpenOptions,
    timeoutMs: number,
  ): Promise<Client> {
    const details = { variant: openOptions.variant, url: rawUrl };
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch (error) {
      throw new AdapterError(`invalid variant url "${rawUrl}"`, { cause: error, details });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new AdapterError(`mcp over http needs an http(s) url, got ${url.protocol}`, {
        details,
      });
    }
    const transportOptions = Object.keys(headers).length > 0 ? { requestInit: { headers } } : {};

    let streamableError: unknown;
    try {
      return await connectClient(
        new StreamableHTTPClientTransport(url, transportOptions),
        clientInfo,
        timeoutMs,
      );
    } catch (error) {
      if (!isHttpRejection(error)) {
        throw new AdapterError(
          `failed to connect to mcp server at ${url.href}: ${shortErrorMessage(error, 200)}`,
          { cause: error, details },
        );
      }
      streamableError = error;
    }
    try {
      return await connectClient(
        new SSEClientTransport(url, transportOptions),
        clientInfo,
        timeoutMs,
      );
    } catch (error) {
      throw new AdapterError(
        `failed to connect to mcp server at ${url.href}: streamable http: ${shortErrorMessage(
          streamableError,
          160,
        )}; sse fallback: ${shortErrorMessage(error, 160)}`,
        { cause: error, details },
      );
    }
  }

  return {
    kind: 'mcp',

    async open(variant: VariantSpec, openOptions: OpenOptions): Promise<AdapterSession> {
      const timeoutMs =
        openOptions.timeoutMs !== undefined && openOptions.timeoutMs > 0
          ? openOptions.timeoutMs
          : defaultConnectTimeoutMs;
      const headers = { ...variant.headers, ...openOptions.headers };

      let client: Client;
      if (options.connect) {
        client = await openInjected(options.connect, variant, openOptions, timeoutMs);
      } else if (variant.command) {
        client = await openStdio(variant.command, variant, openOptions, timeoutMs);
      } else if (variant.url) {
        client = await openHttp(variant.url, headers, openOptions, timeoutMs);
      } else {
        throw new AdapterError(
          'mcp adapter needs variant.url (streamable http or sse) or variant.command (stdio)',
          { details: { variant: openOptions.variant } },
        );
      }

      const session: McpSession = new McpSession({
        client,
        url: variant.url,
        callTimeoutMs,
        maxResultChars,
        onClose: () => {
          sessions.delete(session);
        },
      });
      sessions.add(session);
      return session;
    },

    async dispose(): Promise<void> {
      const open = [...sessions];
      sessions.clear();
      await Promise.all(open.map((session) => session.close().catch(noop)));
    },
  };
}
