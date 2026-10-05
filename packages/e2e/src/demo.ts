import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '@agon/demo-app';
import type { Variant } from '@agon/demo-app';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';

/** A server the tests started; `url` is its origin without a trailing slash. */
export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

/**
 * Stands in for a PostHog ingestion host. The demo app's browser shim posts its events here, so
 * anything the web adapter fails to intercept shows up in `requests`. A passing run leaves it empty.
 */
export interface AnalyticsSink extends RunningServer {
  /** Every request that reached the sink as `METHOD /path?query`, in arrival order. */
  readonly requests: readonly string[];
}

export interface DemoAppOptions {
  /** Where the app's analytics shim sends events; point it at an {@link AnalyticsSink}. */
  posthogHost: string;
}

const HOST = '127.0.0.1';

function originOf(server: ServerType | Server): string {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind a TCP port');
  }
  return `http://${HOST}:${(address as AddressInfo).port}`;
}

/** Drops keep-alive connections first; otherwise `close` waits for the browser to let go of them. */
function closeServer(server: ServerType | Server): Promise<void> {
  if ('closeAllConnections' in server) server.closeAllConnections();
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

/**
 * Starts one variant of the Ledgerly demo app in this process on an ephemeral port, exactly as
 * `examples/demo-app/src/main.ts` would, minus the fixed port and the console banner.
 */
export async function startDemoApp(
  variant: Variant,
  options: DemoAppOptions,
): Promise<RunningServer> {
  const app = createApp({ variant, posthogHost: options.posthogHost, posthogKey: 'phc_agon_e2e' });
  const server = await new Promise<ServerType>((resolve, reject) => {
    const listening: ServerType = serve(
      // Keep Node's own Request/Response: Playwright and the tests share this process.
      { fetch: app.fetch, port: 0, hostname: HOST, overrideGlobalObjects: false },
      () => resolve(listening),
    );
    listening.once('error', reject);
  });
  return { url: originOf(server), close: () => closeServer(server) };
}

/** Starts the analytics sink. It answers every request with PostHog's `{"status":1}`. */
export async function startAnalyticsSink(): Promise<AnalyticsSink> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method ?? 'GET'} ${request.url ?? '/'}`);
    request.resume();
    request.on('end', () => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
      });
      response.end('{"status":1}');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => resolve());
  });
  return { url: originOf(server), requests, close: () => closeServer(server) };
}

/** Reads the demo app's server-side event log (`GET /__events`), optionally for one event name. */
export async function demoAppEvents(
  app: RunningServer,
  event?: string,
): Promise<{ event: string; distinct_id: string; properties: Record<string, unknown> }[]> {
  const url = new URL('/__events', `${app.url}/`);
  if (event !== undefined) url.searchParams.set('event', event);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url.href} failed with ${response.status}`);
  return (await response.json()) as {
    event: string;
    distinct_id: string;
    properties: Record<string, unknown>;
  }[];
}
