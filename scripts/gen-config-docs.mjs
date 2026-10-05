#!/usr/bin/env node
// Generates docs/agon-yaml.md from the JSON Schema exported by @agon/spec.
// Run after `pnpm -F @agon/spec build`: `pnpm docs:config`.
import { writeFileSync } from 'node:fs';
import { agonConfigJsonSchema } from '@agon/spec';

const schema = agonConfigJsonSchema();
const sections = [];
const seen = new Set();

function typeOf(node) {
  if (!node) return '';
  if (node.const !== undefined) return `\`${JSON.stringify(node.const)}\``;
  if (node.enum) return node.enum.map((v) => `\`${v}\``).join(' \\| ');
  if (node.anyOf) return node.anyOf.map(typeOf).join(' or ');
  if (node.oneOf) return 'one of the variants below';
  if (node.type === 'array') return `array of ${typeOf(node.items) || 'items'}`;
  if (node.type === 'object' && node.additionalProperties) return `map of ${typeOf(node.additionalProperties)}`;
  if (node.type === 'object') return 'object';
  if (node.format === 'uri') return 'url';
  if (node.pattern) return `${node.type} matching \`${node.pattern}\``;
  return node.type ?? '';
}

function walk(path, node, title) {
  if (!node || node.type !== 'object' || !node.properties) return;
  const key = path || '(root)';
  if (seen.has(key)) return;
  seen.add(key);
  const required = new Set(node.required ?? []);
  const rows = Object.entries(node.properties).map(([name, prop]) => {
    const def = prop.default === undefined ? '' : `\`${JSON.stringify(prop.default)}\``;
    const req = required.has(name) ? 'yes' : '';
    const desc = (prop.description ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    return `| \`${name}\` | ${typeOf(prop)} | ${req} | ${def} | ${desc} |`;
  });
  sections.push(`## ${title}\n\n| field | type | required | default | description |\n|---|---|---|---|---|\n${rows.join('\n')}\n`);
  for (const [name, prop] of Object.entries(node.properties)) {
    const childPath = path ? `${path}.${name}` : name;
    if (prop.type === 'object' && prop.properties) walk(childPath, prop, `\`${childPath}\``);
    else if (prop.type === 'object' && prop.additionalProperties?.type === 'object') walk(`${childPath}.<key>`, prop.additionalProperties, `\`${childPath}.<key>\``);
    else if (prop.type === 'array' && prop.items?.type === 'object' && prop.items.properties) walk(`${childPath}[]`, prop.items, `\`${childPath}[]\``);
    else if (prop.type === 'array' && prop.items?.oneOf) {
      prop.items.oneOf.forEach((variant) => {
        const tag = variant.properties?.type?.const ?? variant.properties?.kind?.const;
        walk(`${childPath}[] (${tag})`, variant, `\`${childPath}[]\` with \`type: ${tag}\``);
      });
    }
  }
}

walk('', schema, 'Top level');

const header = `# agon.yaml reference

Generated from the Zod schema in \`@agon/spec\` by \`scripts/gen-config-docs.mjs\`. Do not edit by hand; run \`pnpm docs:config\`.

Strings may contain \`\${ENV_VAR}\` or \`\${ENV_VAR:-default}\`; missing variables without a default fail validation. Keys you choose (variants, scenarios, metrics, personas, policies) are slugs: lowercase letters, digits, \`-\` and \`_\`.

\`scenarios[].success\` accepts the shorthand strings \`event:<name>\`, \`url:<pattern>\`, \`text:<needle>\` or \`judge\`, or the object form documented below.
`;

writeFileSync(new URL('../docs/agon-yaml.md', import.meta.url), `${header}\n${sections.join('\n')}`);
console.log(`docs/agon-yaml.md: ${sections.length} sections`);
