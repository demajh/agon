import { createHash } from 'node:crypto';
import type { InteractiveElement } from '@agon/spec';
import type {
  CallToolResult,
  CompatibilityCallToolResult,
  ContentBlock,
  GetPromptResult,
  ReadResourceResult,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * Pure rendering of what an MCP server exposes. The observation text an agent persona reads is
 * built here; `McpSession` only supplies the catalog and the outcome of the last call.
 */

export const DEFAULT_MAX_SCHEMA_CHARS = 400;
export const DEFAULT_MAX_DESCRIPTION_CHARS = 300;
const MAX_SCHEMA_DEPTH = 4;
const MAX_ENUM_VALUES = 12;
const MAX_LITERAL_CHARS = 40;
const MAX_PROPERTY_DESCRIPTION_CHARS = 80;

/** A tool as listed by the server, plus the ref the agent uses in `tool_call`. */
export interface McpToolEntry {
  ref: string;
  name: string;
  title?: string;
  description?: string;
  /** JSON Schema of the arguments, exactly as the server sent it. */
  inputSchema: unknown;
  annotations?: ToolAnnotations;
}

export interface McpResourceEntry {
  ref: string;
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPromptEntry {
  ref: string;
  name: string;
  title?: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

export interface McpCatalog {
  tools: McpToolEntry[];
  resources: McpResourceEntry[];
  prompts: McpPromptEntry[];
}

/** Outcome of the most recent tool call, resource read or prompt fetch. */
export interface McpLastCall {
  kind: 'result' | 'error';
  /** What produced it, e.g. `tool create_project` or `resource ledger://projects`. */
  what: string;
  /** Result text (already capped by the session) or the error message. */
  text: string;
}

export interface RenderCatalogOptions {
  /** Cap on the one-line rendering of each tool's input schema. Default 400. */
  maxSchemaChars?: number;
  /** Cap on each tool, resource and prompt description. Default 300. */
  maxDescriptionChars?: number;
}

/** Cuts `value` to at most `max` characters, ending with an ellipsis when it had to cut. */
export function clipText(value: string, max: number): string {
  const limit = Math.max(1, Math.floor(max));
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function literal(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return clipText(text, MAX_LITERAL_CHARS);
}

function refName(ref: string): string {
  const last = ref.split('/').pop();
  return last && last !== '#' ? last : 'self';
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function renderSchema(schema: unknown, depth: number): string {
  if (schema === true) return 'any';
  if (schema === false) return 'never';
  if (!isRecord(schema)) return 'unknown';
  if (depth > MAX_SCHEMA_DEPTH) return '…';

  const ref = schema['$ref'];
  if (typeof ref === 'string') return refName(ref);

  const enumValues = schema['enum'];
  if (Array.isArray(enumValues)) {
    const shown = enumValues.slice(0, MAX_ENUM_VALUES).map(literal);
    if (enumValues.length > MAX_ENUM_VALUES) shown.push('…');
    return shown.join(' | ');
  }
  if (schema['const'] !== undefined) return literal(schema['const']);

  for (const key of ['anyOf', 'oneOf'] as const) {
    const variants = schema[key];
    if (Array.isArray(variants)) {
      return unique(variants.map((variant) => renderSchema(variant, depth + 1))).join(' | ');
    }
  }
  const allOf = schema['allOf'];
  if (Array.isArray(allOf)) {
    return unique(allOf.map((variant) => renderSchema(variant, depth + 1))).join(' & ');
  }

  const type = schema['type'];
  if (Array.isArray(type)) {
    return unique(type.map((t) => renderTyped(schema, String(t), depth))).join(' | ');
  }
  if (typeof type === 'string') return renderTyped(schema, type, depth);
  if (isRecord(schema['properties'])) return renderObject(schema, depth);
  if (schema['items'] !== undefined) return renderTyped(schema, 'array', depth);
  return 'unknown';
}

function renderTyped(schema: Record<string, unknown>, type: string, depth: number): string {
  switch (type) {
    case 'object':
      return renderObject(schema, depth);
    case 'array': {
      const items = schema['items'];
      if (Array.isArray(items)) {
        return `[${items.map((item) => renderSchema(item, depth + 1)).join(', ')}]`;
      }
      const inner = items === undefined ? 'unknown' : renderSchema(items, depth + 1);
      return inner.includes(' | ') || inner.includes(' & ') ? `(${inner})[]` : `${inner}[]`;
    }
    case 'string': {
      const format = schema['format'];
      return typeof format === 'string' && format !== '' ? `string(${format})` : 'string';
    }
    default:
      return type;
  }
}

function renderObject(schema: Record<string, unknown>, depth: number): string {
  const properties = schema['properties'];
  if (!isRecord(properties) || Object.keys(properties).length === 0) {
    const additional = schema['additionalProperties'];
    return isRecord(additional) ? `Record<string, ${renderSchema(additional, depth + 1)}>` : '{}';
  }
  const requiredRaw = schema['required'];
  const required = new Set(
    Array.isArray(requiredRaw)
      ? requiredRaw.filter((name): name is string => typeof name === 'string')
      : [],
  );
  const parts = Object.entries(properties).map(([name, property]) => {
    let part = `${name}${required.has(name) ? '' : '?'}: ${renderSchema(property, depth + 1)}`;
    if (isRecord(property)) {
      if (property['default'] !== undefined) part += ` = ${literal(property['default'])}`;
      const description = property['description'];
      if (typeof description === 'string' && description.trim() !== '') {
        part += ` (${clipText(oneLine(description), MAX_PROPERTY_DESCRIPTION_CHARS)})`;
      }
    }
    return part;
  });
  return `{${parts.join(', ')}}`;
}

/**
 * One-line, TypeScript-flavoured rendering of a JSON Schema: `{name: string, currency?: "USD" |
 * "EUR" = "USD", tags?: string[]}`. Optional parameters carry `?`, enums list their values,
 * defaults follow `=`, property descriptions sit in parentheses. Cut to `maxChars`.
 */
export function compactSchema(schema: unknown, maxChars = DEFAULT_MAX_SCHEMA_CHARS): string {
  return clipText(renderSchema(schema, 0), maxChars);
}

function describe(text: string | undefined, maxChars: number): string {
  const line = text === undefined ? '' : oneLine(text);
  return line === '' ? '' : ` — ${clipText(line, maxChars)}`;
}

/** Explicit annotation hints worth showing an agent; absent hints are not guessed at. */
function toolFlags(annotations: ToolAnnotations | undefined): string {
  if (!annotations) return '';
  const flags: string[] = [];
  if (annotations.destructiveHint === true) flags.push('destructive');
  if (annotations.readOnlyHint === true) flags.push('read-only');
  if (annotations.idempotentHint === true) flags.push('idempotent');
  return flags.length > 0 ? ` [${flags.join(', ')}]` : '';
}

/** The `TOOLS (n):` section: one block per tool with its ref, description, flags and schema. */
export function renderToolCatalog(
  tools: readonly McpToolEntry[],
  options: RenderCatalogOptions = {},
): string {
  const maxSchemaChars = options.maxSchemaChars ?? DEFAULT_MAX_SCHEMA_CHARS;
  const maxDescriptionChars = options.maxDescriptionChars ?? DEFAULT_MAX_DESCRIPTION_CHARS;
  const lines = [`TOOLS (${tools.length}):`];
  if (tools.length === 0) lines.push('(none)');
  for (const tool of tools) {
    lines.push(
      `${tool.ref} ${tool.name}${describe(tool.description ?? tool.title, maxDescriptionChars)}${toolFlags(tool.annotations)}`,
      `   args: ${compactSchema(tool.inputSchema, maxSchemaChars)}`,
    );
  }
  return lines.join('\n');
}

/** The `RESOURCES (n):` section: `ref uri — title: description (mime type)`. */
export function renderResourceCatalog(
  resources: readonly McpResourceEntry[],
  options: RenderCatalogOptions = {},
): string {
  const maxDescriptionChars = options.maxDescriptionChars ?? DEFAULT_MAX_DESCRIPTION_CHARS;
  const lines = [`RESOURCES (${resources.length}):`];
  if (resources.length === 0) lines.push('(none)');
  for (const resource of resources) {
    const label = oneLine(resource.title ?? resource.name);
    const description = resource.description === undefined ? '' : oneLine(resource.description);
    const summary = [label, description].filter((part) => part !== '').join(': ');
    const mime = resource.mimeType ? ` (${resource.mimeType})` : '';
    lines.push(`${resource.ref} ${resource.uri}${describe(summary, maxDescriptionChars)}${mime}`);
  }
  return lines.join('\n');
}

/** The `PROMPTS (n):` section: `ref name — description (args: a, b?)`. */
export function renderPromptCatalog(
  prompts: readonly McpPromptEntry[],
  options: RenderCatalogOptions = {},
): string {
  const maxDescriptionChars = options.maxDescriptionChars ?? DEFAULT_MAX_DESCRIPTION_CHARS;
  const lines = [`PROMPTS (${prompts.length}):`];
  if (prompts.length === 0) lines.push('(none)');
  for (const prompt of prompts) {
    const args = prompt.arguments ?? [];
    const argList =
      args.length > 0
        ? ` (args: ${args.map((arg) => `${arg.name}${arg.required ? '' : '?'}`).join(', ')})`
        : '';
    lines.push(
      `${prompt.ref} ${prompt.name}${describe(prompt.description ?? prompt.title, maxDescriptionChars)}${argList}`,
    );
  }
  return lines.join('\n');
}

/** The `LAST RESULT:` section, with `LAST ERROR:` when the last call failed. */
export function renderLastCall(last: McpLastCall | undefined): string {
  const lines = ['LAST RESULT:'];
  if (last === undefined) {
    lines.push('(none yet)');
  } else if (last.kind === 'result') {
    lines.push(last.text === '' ? '(empty result)' : last.text);
  } else {
    lines.push(
      `(${last.what} failed)`,
      'LAST ERROR:',
      last.text === '' ? '(no message)' : last.text,
    );
  }
  return lines.join('\n');
}

/** The full observation text: tools, resources, prompts, then the last result. */
export function renderObservationText(
  catalog: McpCatalog,
  last: McpLastCall | undefined,
  options: RenderCatalogOptions = {},
): string {
  return [
    renderToolCatalog(catalog.tools, options),
    renderResourceCatalog(catalog.resources, options),
    renderPromptCatalog(catalog.prompts, options),
    renderLastCall(last),
  ].join('\n');
}

/** The catalog as interactive elements: tools, then resources, then prompts. */
export function catalogInteractive(catalog: McpCatalog): InteractiveElement[] {
  return [
    ...catalog.tools.map((tool) => ({
      ref: tool.ref,
      role: 'tool',
      name: tool.name,
      disabled: false,
    })),
    ...catalog.resources.map((resource) => ({
      ref: resource.ref,
      role: 'resource',
      name: resource.uri,
      href: resource.uri,
      disabled: false,
    })),
    ...catalog.prompts.map((prompt) => ({
      ref: prompt.ref,
      role: 'prompt',
      name: prompt.name,
      disabled: false,
    })),
  ];
}

/**
 * sha1 over the catalog (tool names, resource uris, prompt names) and the last call's outcome.
 * Independent of the observation caps, so the same server state hashes the same for every persona.
 */
export function catalogHash(catalog: McpCatalog, last: McpLastCall | undefined): string {
  const hash = createHash('sha1');
  hash.update(catalog.tools.map((tool) => tool.name).join('\n'));
  hash.update('\n--\n');
  hash.update(catalog.resources.map((resource) => resource.uri).join('\n'));
  hash.update('\n--\n');
  hash.update(catalog.prompts.map((prompt) => prompt.name).join('\n'));
  hash.update('\n--\n');
  hash.update(last === undefined ? '' : `${last.kind}|${last.what}|${last.text}`);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// Result rendering: content blocks become text the agent can read.
// ---------------------------------------------------------------------------

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function renderContentBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'image':
      return `[image ${block.mimeType}, ${block.data.length} base64 chars]`;
    case 'audio':
      return `[audio ${block.mimeType}, ${block.data.length} base64 chars]`;
    case 'resource':
      return 'text' in block.resource
        ? `[resource ${block.resource.uri}]\n${block.resource.text}`
        : `[resource ${block.resource.uri} (${block.resource.mimeType ?? 'binary'}, ${block.resource.blob.length} base64 chars)]`;
    case 'resource_link': {
      const name = block.title ?? block.name;
      const description = block.description ? `: ${oneLine(block.description)}` : '';
      return `[resource link ${block.uri} — ${name}${description}]`;
    }
    default:
      return `[${String((block as { type: unknown }).type)}]`;
  }
}

/** Text blocks verbatim; images, audio and binary resources described in brackets. */
export function renderContentBlocks(blocks: readonly ContentBlock[]): string {
  return blocks.map(renderContentBlock).join('\n');
}

/**
 * Content blocks, else structured content as JSON, else the pre-2025 `toolResult` as JSON. The
 * SDK has already validated the result against its schema, so the shape is trusted here.
 */
export function renderCallToolResult(result: CallToolResult | CompatibilityCallToolResult): string {
  const view = result as { content?: unknown; structuredContent?: unknown; toolResult?: unknown };
  if (Array.isArray(view.content)) {
    const text = renderContentBlocks(view.content as ContentBlock[]);
    if (text.trim() !== '') return text;
    return view.structuredContent === undefined ? text : stringify(view.structuredContent);
  }
  if ('toolResult' in view) return stringify(view.toolResult);
  return view.structuredContent === undefined ? '' : stringify(view.structuredContent);
}

/** Text contents verbatim (prefixed with their uri when there are several); blobs described. */
export function renderReadResourceResult(result: ReadResourceResult): string {
  const several = result.contents.length > 1;
  return result.contents
    .map((content) => {
      const body =
        'text' in content
          ? content.text
          : `[blob ${content.mimeType ?? 'application/octet-stream'}, ${content.blob.length} base64 chars]`;
      return several ? `[${content.uri}]\n${body}` : body;
    })
    .join('\n');
}

/** The prompt's description, then one `role: content` line per message. */
export function renderGetPromptResult(result: GetPromptResult): string {
  const lines: string[] = [];
  if (result.description) lines.push(result.description);
  for (const message of result.messages) {
    lines.push(`${message.role}: ${renderContentBlocks([message.content])}`);
  }
  return lines.join('\n');
}
