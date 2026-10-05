import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { isVariant } from './types.js';

const variant = process.env['VARIANT'] ?? 'control';
if (!isVariant(variant)) {
  throw new Error(`VARIANT must be "control" or "treatment", got "${variant}"`);
}
const port = Number(process.env['PORT'] ?? 3000);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`PORT must be a port number, got "${process.env['PORT']}"`);
}

const app = createApp({
  variant,
  posthogHost: process.env['POSTHOG_HOST'],
  posthogKey: process.env['POSTHOG_KEY'],
});

const server = serve(
  { fetch: app.fetch, port, hostname: process.env['HOST'] ?? '0.0.0.0' },
  (info) => {
    console.log(`Ledgerly demo (${variant}) listening on http://localhost:${info.port}`);
  },
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
