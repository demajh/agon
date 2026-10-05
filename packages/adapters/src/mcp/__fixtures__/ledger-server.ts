import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/**
 * A tiny offline MCP server the adapter tests drive: a project ledger with four tools (one
 * destructive, one flaky), a resource and a prompt. Every instance has its own state.
 */

export interface LedgerProject {
  id: string;
  name: string;
  currency: 'USD' | 'EUR';
}

export interface LedgerState {
  projects: LedgerProject[];
  flakyCalls: number;
}

export const LEDGER_SERVER_INFO = { name: 'ledger', version: '1.0.0' };

export function createLedgerServer(): { server: McpServer; state: LedgerState } {
  const state: LedgerState = { projects: [], flakyCalls: 0 };
  const server = new McpServer(LEDGER_SERVER_INFO);

  server.registerTool(
    'create_project',
    {
      title: 'Create project',
      description: 'Create a new project in the ledger.',
      inputSchema: {
        name: z.string().min(1).describe('Display name of the project'),
        currency: z.enum(['USD', 'EUR']).describe('Billing currency; defaults to USD').optional(),
      },
      annotations: { destructiveHint: false },
    },
    async ({ name, currency }) => {
      const project: LedgerProject = {
        id: `p${state.projects.length + 1}`,
        name,
        currency: currency ?? 'USD',
      };
      state.projects.push(project);
      return { content: [{ type: 'text', text: `created project "${name}" (${project.id})` }] };
    },
  );

  server.registerTool(
    'list_projects',
    {
      description: 'List every project with its id, name and currency.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ({
      content: [
        {
          type: 'text',
          text:
            state.projects.length === 0
              ? 'no projects yet'
              : state.projects.map((p) => `${p.id} ${p.name} (${p.currency})`).join('\n'),
        },
      ],
    }),
  );

  server.registerTool(
    'delete_project',
    {
      description: 'Delete a project by id.',
      inputSchema: { id: z.string().describe('Project id, e.g. p1') },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ id }) => {
      const index = state.projects.findIndex((p) => p.id === id);
      if (index === -1) {
        return { isError: true, content: [{ type: 'text', text: `no project with id ${id}` }] };
      }
      state.projects.splice(index, 1);
      return { content: [{ type: 'text', text: `deleted project ${id}` }] };
    },
  );

  server.registerTool(
    'flaky',
    {
      description: 'Fails the first time it is called, then succeeds.',
      inputSchema: { n: z.number().int().describe('Any integer') },
    },
    async ({ n }) => {
      state.flakyCalls += 1;
      if (state.flakyCalls === 1) {
        return { isError: true, content: [{ type: 'text', text: 'transient failure: try again' }] };
      }
      return { content: [{ type: 'text', text: `flaky ok (n=${n})` }] };
    },
  );

  server.registerResource(
    'projects',
    'ledger://projects',
    { title: 'Projects', description: 'All projects as JSON', mimeType: 'application/json' },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(state.projects) },
      ],
    }),
  );

  server.registerPrompt(
    'monthly_close',
    { title: 'Monthly close', description: 'Walk through the monthly close for every project.' },
    async () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: 'Close the books for every project: list them, then confirm each balance.',
          },
        },
      ],
    }),
  );

  return { server, state };
}
