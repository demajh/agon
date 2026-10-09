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
  if (node.type === 'object' && node.additionalProperties)
    return `map of ${typeOf(node.additionalProperties)}`;
  if (node.type === 'object') return 'object';
  if (node.format === 'uri') return 'url';
  if (node.format === 'date-time') return 'ISO-8601 timestamp';
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
  sections.push(
    `## ${title}\n\n| field | type | required | default | description |\n|---|---|---|---|---|\n${rows.join('\n')}\n`,
  );
  for (const [name, prop] of Object.entries(node.properties)) {
    const childPath = path ? `${path}.${name}` : name;
    if (prop.type === 'object' && prop.properties) walk(childPath, prop, `\`${childPath}\``);
    else if (prop.type === 'object' && prop.additionalProperties?.type === 'object')
      walk(`${childPath}.<key>`, prop.additionalProperties, `\`${childPath}.<key>\``);
    else if (prop.type === 'array' && prop.items?.type === 'object' && prop.items.properties)
      walk(`${childPath}[]`, prop.items, `\`${childPath}[]\``);
    else if (prop.type === 'array' && prop.items?.oneOf) {
      prop.items.oneOf.forEach((variant) => {
        const key = variant.properties?.type?.const !== undefined ? 'type' : 'kind';
        const tag = variant.properties?.[key]?.const;
        walk(`${childPath}[] (${tag})`, variant, `\`${childPath}[]\` with \`${key}: ${tag}\``);
      });
    }
  }
}

walk('', schema, 'Top level');

const header = `# agon.yaml reference

Generated from the Zod schema in \`@agon/spec\` by \`scripts/gen-config-docs.mjs\`. Do not edit by hand; run \`pnpm docs:config\`.

Strings may contain \`\${ENV_VAR}\` or \`\${ENV_VAR:-default}\`; missing variables without a default fail validation. Keys you choose (variants, scenarios, metrics, personas, policies) are slugs: lowercase letters, digits, \`-\` and \`_\`.

\`scenarios[].success\` accepts the shorthand strings \`event:<name>\`, \`url:<pattern>\`, \`text:<needle>\` or \`judge\`, or the object form documented below.

## Stopping rules

A session has three hard stops, all per scenario: \`maxSteps\`, \`budgetUsd\` and \`stallSteps\`. Each ends the session with its own outcome (\`max_steps\`, \`budget_exceeded\`, \`stalled\`), so the three are never confused in the analysis.

\`stallSteps\` is stall detection. Every action or tool call is a step; after each step the engine hashes what \`progress\` declares as progress (\`observation\`: the adapter observation, that is URL plus page text and controls for web targets and the tool catalog plus the last tool result for mcp targets; \`events\`: the number of intercepted analytics events and successful tool calls captured so far, "a new row landed"; \`both\`: either). The session keeps a \`stepsSinceProgress\` counter that resets to 0 whenever the hash changes; when it reaches \`stallSteps\` the session ends with outcome \`stalled\` and the reason "no progress for N steps". Every session records \`maxStepsSinceProgress\`, \`lastProgressStep\` and \`progressSteps\`; \`agon stall-report <run>\` prints the distribution of gaps between progress events so the threshold can be chosen from data.

Recommended value: about 60 for edit-heavy tasks. Measured on 820 real coding-agent sessions, the gaps between writes had p50 6, p90 21, p95 32, p99 58 and max 109 steps, so a threshold of 10 would end a quarter of real stretches. Leave \`stallSteps\` unset (the default, detection off) for scenarios that poll: a poller that correctly finds nothing new is not stuck, and its observation never changes.

The run as a whole has a wall-clock cap, \`defaults.timeCapMs\` (default 720000, twelve minutes), counted from the moment the run starts: queue time, cold start, adapter setup and session hooks are inside it. When it is reached no new session starts, sessions in flight stop between steps and are recorded without an outcome, and the run ends as a typed partial result (\`termination.kind = time_cap_reached\`, exit code 3) rather than a failure. See [run-termination.md](run-termination.md).

## Policy gates

\`policies[]\` holds two families, told apart by \`kind\`. The default, \`kind: squad\` (it can be left out), is a squad governance policy: when its \`when\` matches a run or a result it reallocates, pauses, resumes, kills or notifies, always through a \`Decision\` row. The other three kinds are gates, checks on what a variant changes, each enforced at its own point. Where a gate only reports, this section says so. Every policy, gates included, is part of the requirements digest each result carries, together with the analysis section and its materiality boundary ([receipts-and-findings.md](receipts-and-findings.md)).

### \`protected_paths\`

Some files are written by an agent but read and acted on later by a process with more privileges than the agent had: CI workflow files, MCP server definitions, deploy manifests, lockfiles. \`paths\` lists them as globs (\`*\` within one path segment, \`**\` across segments, \`?\` one character). A variant whose diff touches one is blocked unless \`approvals\` holds an approval for that exact diff hash. Approvals are recorded against the diff, never against a variant name, so a variant that changes again needs a new approval.

- **Enforced at variant registration.** \`POST /v1/environments/{id}/variants\` carries a diff manifest, \`diff: { hash, paths, base?, head? }\`. A blocked registration is refused with 403 \`policy_blocked\` naming each blocking policy and path, and nothing is stored. A registration without a manifest is refused while \`requireManifest\` is true (the default); with \`requireManifest: false\` it is let through unchecked and the gate is advisory.
- **The hash is canonical.** \`agon gate protected-paths --base origin/main\` computes the manifest from git: the sha256 of \`git diff --no-color --no-ext-diff --no-renames --full-index --binary <base>...<head>\` (the change since the merge base; a rename counts as both of its paths) and the paths it touches. It checks the manifest against the config's policies, exits 1 when one blocks it, and prints the manifest with \`--json\`, so the approver and the registrant compute the same hash.
- **What it does not catch.** The server has no repository to recompute the diff from, so it checks the manifest the registrant declares: a registrant that lies about its diff passes. The gate is a tripwire for careless changes, not a defence against a hostile agent. Local \`agon run\` registers no variants and does not check this policy.
- **Open question: where should the approval happen?** In the pull request, where a reviewer approves the hash before merge (what this implements, checked at the first point Agon sees the change), or at the agent runtime before the file is written, where the harness refuses an unapproved write. The second stops the change before any process can act on it, but needs a hook in every agent runtime. Reviewers' views are welcome.

### \`side_effects\`

Snapshot, call, snapshot. The engine snapshots the places allowed to change before and after each session (\`scope: session\`: after the setup hook, before the teardown hook) or each tool call (\`scope: tool_call\`), and compares the two. There are two observation points: the file tree under \`observe.files.root\` (a content hash per file; a symbolic link is recorded by its target and never followed; \`ignore\` globs are skipped) and the process table (\`observe.processes\`, unix \`ps\`; each entry is \`proc:<command line>\`). The network is not observable, and every report says so (\`not_observable: ["network"]\`).

Each change is matched against \`expected\`: file globs match paths under the root, \`proc:\` globs match whole command lines (there \`*\` also crosses \`/\`). Every comparison is recorded as a \`$agon_side_effects\` event with the number of changes, expected and unexpected ones, the first 50 unexpected changes, and \`expected_list_size\`, the length of the expected list, so a list that only ever grows shows up over time.

Advisory: the gate counts and records; it neither stops the session nor fails the run. The process table is the whole machine's, so unrelated processes that start or exit during the call count as unexpected: observe processes on a quiet host, or list the noise in \`expected\`.

### \`shadow_diff\`

Control and variant receive the same input and their outputs are compared field by field, schema first. \`contract.fields\` maps dotted field paths (globs: \`*\` per segment, \`**\` across segments; an exact field name wins, otherwise the first matching pattern in the order written) to \`allow\` (may differ; skipped), \`disallow\` (a difference counts) or \`semantic\` (may differ in form but not in meaning). Only \`semantic\` fields go to a judge. A field the contract does not name is \`disallow\` when it is inside the materiality boundary (\`analysis.materiality.fields\`) and \`contract.default\` otherwise. A field present on one side only is a difference; array elements are compared by index.

Each disallowed difference gets a \`diffHash\` (the field and both values) and is charged against \`budget.disallowedDiffs\`, which has an \`owner\` and an \`expiresAt\`. After expiry the gate fails whatever the count. \`exceptions\` are hand-written, each naming a field and a diffHash with an owner and an expiry; a live exception covers exactly that difference. Approving the same disallowed diff twice (the same field and diffHash listed twice, a renewal included) is a config error: a difference approved repeatedly is a contract change, so set \`contract.fields\` for that field explicitly instead.

\`agon gate shadow-diff --control control.json --variant variant.json\` runs the comparison and exits 1 over budget. The CLI has no judge, so it counts a difference in a \`semantic\` field as material; the library function \`judgeSemanticDiffs\` accepts any judge. Agon does not mirror traffic into control and variant itself: produce the two outputs, then compare them.
`;

writeFileSync(
  new URL('../docs/agon-yaml.md', import.meta.url),
  `${header}\n${sections.join('\n')}`,
);
console.log(`docs/agon-yaml.md: ${sections.length} sections`);
