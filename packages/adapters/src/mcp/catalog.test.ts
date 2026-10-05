import { describe, expect, it } from 'vitest';
import {
  catalogHash,
  catalogInteractive,
  compactSchema,
  renderCallToolResult,
  renderGetPromptResult,
  renderObservationText,
  renderReadResourceResult,
  renderToolCatalog,
} from './catalog.js';
import type { McpCatalog } from './catalog.js';
import { formatCommand, parseCommand } from './command.js';

describe('compactSchema', () => {
  it('renders objects, enums, defaults, arrays, formats, unions, maps and refs on one line', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, description: 'Display name' },
        currency: { type: 'string', enum: ['USD', 'EUR'], default: 'USD' },
        tags: { type: 'array', items: { type: 'string' } },
        owner: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' }, admin: { type: 'boolean' } },
          required: ['id'],
        },
        limit: { type: ['integer', 'null'] },
        mode: { anyOf: [{ const: 'fast' }, { const: 'slow' }] },
        meta: { type: 'object', additionalProperties: { type: 'number' } },
        parent: { $ref: '#/$defs/Project' },
        pairs: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
      },
      required: ['name', 'owner'],
      additionalProperties: false,
    };
    expect(compactSchema(schema)).toBe(
      '{name: string (Display name), currency?: "USD" | "EUR" = "USD", tags?: string[], ' +
        'owner: {id: string(uuid), admin?: boolean}, limit?: integer | null, mode?: "fast" | "slow", ' +
        'meta?: Record<string, number>, parent?: Project, pairs?: (string | number)[]}',
    );
  });

  it('handles empty, boolean, malformed and deeply nested schemas', () => {
    expect(compactSchema({ type: 'object' })).toBe('{}');
    expect(compactSchema({ type: 'object', properties: {} })).toBe('{}');
    expect(compactSchema(true)).toBe('any');
    expect(compactSchema(undefined)).toBe('unknown');
    expect(compactSchema('nope')).toBe('unknown');
    expect(compactSchema({ items: { type: 'string' } })).toBe('string[]');
    let nested: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 8; i += 1) nested = { type: 'object', properties: { child: nested } };
    const rendered = compactSchema(nested);
    expect(rendered).toContain('…');
    expect(rendered.startsWith('{child?: {child?: ')).toBe(true);
  });

  it('cuts long schemas at the cap and shortens long enums', () => {
    const wide = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 60 }, (_, i) => [`field_${i}`, { type: 'string' }]),
      ),
    };
    const cut = compactSchema(wide, 100);
    expect(cut).toHaveLength(100);
    expect(cut.endsWith('…')).toBe(true);
    const many = { enum: Array.from({ length: 20 }, (_, i) => `v${i}`) };
    expect(compactSchema(many)).toMatch(/^"v0" \| "v1" .* \| "v11" \| …$/);
  });
});

const catalog: McpCatalog = {
  tools: [
    {
      ref: 't1',
      name: 'create_project',
      description: 'Create a new project.\n\nReturns its id.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, currency: { enum: ['USD', 'EUR'] } },
        required: ['name'],
      },
      annotations: { destructiveHint: false },
    },
    {
      ref: 't2',
      name: 'delete_project',
      title: 'Delete project',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
  ],
  resources: [
    {
      ref: 'r1',
      uri: 'ledger://projects',
      name: 'projects',
      title: 'Projects',
      description: 'All projects as JSON',
      mimeType: 'application/json',
    },
  ],
  prompts: [
    {
      ref: 'p1',
      name: 'monthly_close',
      description: 'Walk through the monthly close.',
      arguments: [{ name: 'month', required: true }, { name: 'dry_run' }],
    },
  ],
};

describe('renderToolCatalog / renderObservationText', () => {
  it('renders every section with refs, descriptions, flags, schemas and the last result', () => {
    expect(renderToolCatalog(catalog.tools)).toBe(
      [
        'TOOLS (2):',
        't1 create_project — Create a new project. Returns its id.',
        '   args: {name: string, currency?: "USD" | "EUR"}',
        't2 delete_project — Delete project [destructive, idempotent]',
        '   args: {id: string}',
      ].join('\n'),
    );
    expect(renderObservationText(catalog, undefined)).toBe(
      [
        renderToolCatalog(catalog.tools),
        'RESOURCES (1):',
        'r1 ledger://projects — Projects: All projects as JSON (application/json)',
        'PROMPTS (1):',
        'p1 monthly_close — Walk through the monthly close. (args: month, dry_run?)',
        'LAST RESULT:',
        '(none yet)',
      ].join('\n'),
    );
    expect(
      renderObservationText(
        { tools: [], resources: [], prompts: [] },
        { kind: 'result', what: 'tool list_projects', text: 'p1 Apollo (USD)' },
      ),
    ).toBe(
      [
        'TOOLS (0):',
        '(none)',
        'RESOURCES (0):',
        '(none)',
        'PROMPTS (0):',
        '(none)',
        'LAST RESULT:',
        'p1 Apollo (USD)',
      ].join('\n'),
    );
    expect(
      renderObservationText(
        { tools: [], resources: [], prompts: [] },
        { kind: 'error', what: 'tool create_project', text: 'Invalid arguments' },
      ),
    ).toContain(
      ['LAST RESULT:', '(tool create_project failed)', 'LAST ERROR:', 'Invalid arguments'].join(
        '\n',
      ),
    );
  });

  it('caps schemas and descriptions through the options', () => {
    const text = renderToolCatalog(catalog.tools, { maxSchemaChars: 12, maxDescriptionChars: 10 });
    expect(text).toContain('t1 create_project — Create a …');
    expect(text).toContain('   args: {name: stri…');
  });

  it('turns the catalog into interactive elements and hashes names plus the last call', () => {
    expect(catalogInteractive(catalog)).toEqual([
      { ref: 't1', role: 'tool', name: 'create_project', disabled: false },
      { ref: 't2', role: 'tool', name: 'delete_project', disabled: false },
      {
        ref: 'r1',
        role: 'resource',
        name: 'ledger://projects',
        href: 'ledger://projects',
        disabled: false,
      },
      { ref: 'p1', role: 'prompt', name: 'monthly_close', disabled: false },
    ]);
    const base = catalogHash(catalog, undefined);
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    expect(catalogHash({ ...catalog, tools: [...catalog.tools] }, undefined)).toBe(base);
    expect(catalogHash(catalog, { kind: 'result', what: 'tool x', text: 'ok' })).not.toBe(base);
    expect(catalogHash({ ...catalog, prompts: [] }, undefined)).not.toBe(base);
  });
});

describe('result rendering', () => {
  it('concatenates text blocks and describes the others', () => {
    expect(
      renderCallToolResult({
        content: [
          { type: 'text', text: 'line one' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'audio', data: 'AAAAAA', mimeType: 'audio/wav' },
          { type: 'resource', resource: { uri: 'file:///a.txt', text: 'inside' } },
          { type: 'resource', resource: { uri: 'file:///b.bin', blob: 'AAAA' } },
          {
            type: 'resource_link',
            uri: 'ledger://projects',
            name: 'projects',
            description: 'All\nprojects',
          },
        ],
      }),
    ).toBe(
      [
        'line one',
        '[image image/png, 4 base64 chars]',
        '[audio audio/wav, 6 base64 chars]',
        '[resource file:///a.txt]',
        'inside',
        '[resource file:///b.bin (binary, 4 base64 chars)]',
        '[resource link ledger://projects — projects: All projects]',
      ].join('\n'),
    );
  });

  it('falls back to structured content and to the legacy toolResult', () => {
    expect(renderCallToolResult({ content: [], structuredContent: { total: 3 } })).toBe(
      '{"total":3}',
    );
    expect(renderCallToolResult({ toolResult: ['a', 1] })).toBe('["a",1]');
    expect(renderCallToolResult({ content: [] })).toBe('');
  });

  it('renders resource contents and prompt messages', () => {
    expect(renderReadResourceResult({ contents: [{ uri: 'ledger://projects', text: '[]' }] })).toBe(
      '[]',
    );
    expect(
      renderReadResourceResult({
        contents: [
          { uri: 'a://1', text: 'one' },
          { uri: 'a://2', blob: 'AAAA', mimeType: 'image/png' },
        ],
      }),
    ).toBe('[a://1]\none\n[a://2]\n[blob image/png, 4 base64 chars]');
    expect(
      renderGetPromptResult({
        description: 'Close the month',
        messages: [
          { role: 'user', content: { type: 'text', text: 'Close the books.' } },
          { role: 'assistant', content: { type: 'text', text: 'Which month?' } },
        ],
      }),
    ).toBe('Close the month\nuser: Close the books.\nassistant: Which month?');
  });
});

describe('parseCommand / formatCommand', () => {
  it('tokenises like a shell without expanding anything', () => {
    expect(parseCommand('node server.js --port 3000')).toEqual([
      'node',
      'server.js',
      '--port',
      '3000',
    ]);
    expect(parseCommand(`node "a b/server.js" --flag='x y' plain\\ arg`)).toEqual([
      'node',
      'a b/server.js',
      '--flag=x y',
      'plain arg',
    ]);
    expect(parseCommand('echo "quoted \\" quote" \'$HOME\' ""')).toEqual([
      'echo',
      'quoted " quote',
      '$HOME',
      '',
    ]);
    expect(parseCommand('   ')).toEqual([]);
    expect(() => parseCommand('node "unterminated')).toThrow(/unterminated double quote/);
    expect(() => parseCommand("node 'unterminated")).toThrow(/unterminated single quote/);
  });

  it('formats arguments so that parsing them gives the original argv back', () => {
    const args = ['/usr/local/bin/node', '/tmp/with space/cli.mjs', 'it\'s "quoted"', '$HOME', ''];
    expect(formatCommand(['node', 'server.js'])).toBe('node server.js');
    expect(parseCommand(formatCommand(args))).toEqual(args);
  });
});
