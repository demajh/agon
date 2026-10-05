import { isAgonError } from '@agon/spec';
import pino from 'pino';
import { readServerConfig } from './config.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const config = readServerConfig(process.env);
  const logger = pino({ level: config.logLevel });
  const server = createServer({ config, logger });
  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    server
      .stop()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, 'shutdown failed');
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  await server.start();
}

main().catch((error: unknown) => {
  const message = isAgonError(error) || error instanceof Error ? error.message : String(error);
  pino().fatal({ err: error }, `agon server failed to start: ${message}`);
  process.exit(1);
});
