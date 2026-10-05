import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createLedgerServer } from './ledger-server.js';

/**
 * Entry point for the stdio transport test: the ledger server on stdin/stdout, plus a tool that
 * reveals the child's environment so the test can prove `variant.env` and credentials arrived.
 * Run with `node <tsx cli> ledger-stdio.ts`.
 */
const { server } = createLedgerServer();

server.registerTool(
  'env',
  {
    description: 'Show one environment variable of the server process.',
    inputSchema: { name: z.string().describe('Variable name') },
  },
  async ({ name }) => ({
    content: [{ type: 'text', text: `${name}=${process.env[name] ?? ''}` }],
  }),
);

server.server.onclose = () => {
  process.exit(0);
};

await server.connect(new StdioServerTransport());
