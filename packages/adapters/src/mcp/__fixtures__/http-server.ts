import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createLedgerServer } from './ledger-server.js';
import type { LedgerState } from './ledger-server.js';

/**
 * The ledger server behind a plain `node:http` server, over both HTTP transports:
 *
 * - `/mcp`: Streamable HTTP, stateful (one server instance per `mcp-session-id`).
 * - `/sse` + `/messages`: the legacy SSE transport. `POST /sse` answers 405, which is what makes
 *   the adapter fall back from Streamable HTTP to SSE.
 */
export interface LedgerHttpServer {
  baseUrl: string;
  streamableUrl: string;
  sseUrl: string;
  /** Method, path and headers of every request received, in arrival order. */
  requests: { method: string; path: string; headers: IncomingHttpHeaders }[];
  /** One ledger state per MCP session the server created. */
  states: LedgerState[];
  close(): Promise<void>;
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export async function startLedgerHttpServer(): Promise<LedgerHttpServer> {
  const requests: LedgerHttpServer['requests'] = [];
  const states: LedgerState[] = [];
  const streamable = new Map<string, StreamableHTTPServerTransport>();
  const sse = new Map<string, SSEServerTransport>();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    requests.push({ method, path: url.pathname, headers: req.headers });

    if (url.pathname === '/mcp') {
      const sessionId = headerValue(req, 'mcp-session-id');
      if (sessionId !== undefined) {
        const transport = streamable.get(sessionId);
        if (!transport) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32001, message: 'session not found' },
              id: null,
            }),
          );
          return;
        }
        await transport.handleRequest(req, res);
        return;
      }
      if (method !== 'POST') {
        res.writeHead(405, { allow: 'POST' });
        res.end('method not allowed');
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          streamable.set(id, transport);
        },
        onsessionclosed: (id) => {
          streamable.delete(id);
        },
      });
      const { server, state } = createLedgerServer();
      states.push(state);
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    if (url.pathname === '/sse') {
      if (method !== 'GET') {
        res.writeHead(405, { allow: 'GET' });
        res.end('method not allowed');
        return;
      }
      const transport = new SSEServerTransport('/messages', res);
      sse.set(transport.sessionId, transport);
      const { server, state } = createLedgerServer();
      states.push(state);
      server.server.onclose = () => {
        sse.delete(transport.sessionId);
      };
      await server.connect(transport);
      return;
    }

    if (url.pathname === '/messages' && method === 'POST') {
      const transport = sse.get(url.searchParams.get('sessionId') ?? '');
      if (!transport) {
        res.writeHead(404);
        res.end('unknown session');
        return;
      }
      await transport.handlePostMessage(req, res);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    streamableUrl: `${baseUrl}/mcp`,
    sseUrl: `${baseUrl}/sse`,
    requests,
    states,
    close: async () => {
      await Promise.all(
        [...streamable.values(), ...sse.values()].map((transport) =>
          transport.close().catch(() => undefined),
        ),
      );
      await new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
