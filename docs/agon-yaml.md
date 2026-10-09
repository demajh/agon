# agon.yaml reference

Generated from the Zod schema in `@agon/spec` by `scripts/gen-config-docs.mjs`. Do not edit by hand; run `pnpm docs:config`.

Strings may contain `${ENV_VAR}` or `${ENV_VAR:-default}`; missing variables without a default fail validation. Keys you choose (variants, scenarios, metrics, personas, policies) are slugs: lowercase letters, digits, `-` and `_`.

`scenarios[].success` accepts the shorthand strings `event:<name>`, `url:<pattern>`, `text:<needle>` or `judge`, or the object form documented below.

## Stopping rules

A session has three hard stops, all per scenario: `maxSteps`, `budgetUsd` and `stallSteps`. Each ends the session with its own outcome (`max_steps`, `budget_exceeded`, `stalled`), so the three are never confused in the analysis.

`stallSteps` is stall detection. Every action or tool call is a step; after each step the engine hashes what `progress` declares as progress (`observation`: the adapter observation, that is URL plus page text and controls for web targets and the tool catalog plus the last tool result for mcp targets; `events`: the number of intercepted analytics events and successful tool calls captured so far, "a new row landed"; `both`: either). The session keeps a `stepsSinceProgress` counter that resets to 0 whenever the hash changes; when it reaches `stallSteps` the session ends with outcome `stalled` and the reason "no progress for N steps". Every session records `maxStepsSinceProgress`, `lastProgressStep` and `progressSteps`; `agon stall-report <run>` prints the distribution of gaps between progress events so the threshold can be chosen from data.

Recommended value: about 60 for edit-heavy tasks. Measured on 820 real coding-agent sessions, the gaps between writes had p50 6, p90 21, p95 32, p99 58 and max 109 steps, so a threshold of 10 would end a quarter of real stretches. Leave `stallSteps` unset (the default, detection off) for scenarios that poll: a poller that correctly finds nothing new is not stuck, and its observation never changes.

The run as a whole has a wall-clock cap, `defaults.timeCapMs` (default 720000, twelve minutes), counted from the moment the run starts: queue time, cold start, adapter setup and session hooks are inside it. When it is reached no new session starts, sessions in flight stop between steps and are recorded without an outcome, and the run ends as a typed partial result (`termination.kind = time_cap_reached`, exit code 3) rather than a failure. See [run-termination.md](run-termination.md).

## Policy gates

`policies[]` holds two families, told apart by `kind`. The default, `kind: squad` (it can be left out), is a squad governance policy: when its `when` matches a run or a result it reallocates, pauses, resumes, kills or notifies, always through a `Decision` row. The other three kinds are gates, checks on what a variant changes, each enforced at its own point. Where a gate only reports, this section says so. Every policy, gates included, is part of the requirements digest each result carries, together with the analysis section and its materiality boundary ([receipts-and-findings.md](receipts-and-findings.md)).

### `protected_paths`

Some files are written by an agent but read and acted on later by a process with more privileges than the agent had: CI workflow files, MCP server definitions, deploy manifests, lockfiles. `paths` lists them as globs (`*` within one path segment, `**` across segments, `?` one character). A variant whose diff touches one is blocked unless `approvals` holds an approval for that exact diff hash. Approvals are recorded against the diff, never against a variant name, so a variant that changes again needs a new approval.

- **Enforced at variant registration.** `POST /v1/environments/{id}/variants` carries a diff manifest, `diff: { hash, paths, base?, head? }`. A blocked registration is refused with 403 `policy_blocked` naming each blocking policy and path, and nothing is stored. A registration without a manifest is refused while `requireManifest` is true (the default); with `requireManifest: false` it is let through unchecked and the gate is advisory.
- **The hash is canonical.** `agon gate protected-paths --base origin/main` computes the manifest from git: the sha256 of `git diff --no-color --no-ext-diff --no-renames --full-index --binary <base>...<head>` (the change since the merge base; a rename counts as both of its paths) and the paths it touches. It checks the manifest against the config's policies, exits 1 when one blocks it, and prints the manifest with `--json`, so the approver and the registrant compute the same hash.
- **What it does not catch.** The server has no repository to recompute the diff from, so it checks the manifest the registrant declares: a registrant that lies about its diff passes. The gate is a tripwire for careless changes, not a defence against a hostile agent. Local `agon run` registers no variants and does not check this policy.
- **Open question: where should the approval happen?** In the pull request, where a reviewer approves the hash before merge (what this implements, checked at the first point Agon sees the change), or at the agent runtime before the file is written, where the harness refuses an unapproved write. The second stops the change before any process can act on it, but needs a hook in every agent runtime. Reviewers' views are welcome.

### `side_effects`

Snapshot, call, snapshot. The engine snapshots the places allowed to change before and after each session (`scope: session`: after the setup hook, before the teardown hook) or each tool call (`scope: tool_call`), and compares the two. There are two observation points: the file tree under `observe.files.root` (a content hash per file; a symbolic link is recorded by its target and never followed; `ignore` globs are skipped) and the process table (`observe.processes`, unix `ps`; each entry is `proc:<command line>`). The network is not observable, and every report says so (`not_observable: ["network"]`).

Each change is matched against `expected`: file globs match paths under the root, `proc:` globs match whole command lines (there `*` also crosses `/`). Every comparison is recorded as a `$agon_side_effects` event with the number of changes, expected and unexpected ones, the first 50 unexpected changes, and `expected_list_size`, the length of the expected list, so a list that only ever grows shows up over time.

Advisory: the gate counts and records; it neither stops the session nor fails the run. The process table is the whole machine's, so unrelated processes that start or exit during the call count as unexpected: observe processes on a quiet host, or list the noise in `expected`.

### `shadow_diff`

Control and variant receive the same input and their outputs are compared field by field, schema first. `contract.fields` maps dotted field paths (globs: `*` per segment, `**` across segments; an exact field name wins, otherwise the first matching pattern in the order written) to `allow` (may differ; skipped), `disallow` (a difference counts) or `semantic` (may differ in form but not in meaning). Only `semantic` fields go to a judge. A field the contract does not name is `disallow` when it is inside the materiality boundary (`analysis.materiality.fields`) and `contract.default` otherwise. A field present on one side only is a difference; array elements are compared by index.

Each disallowed difference gets a `diffHash` (the field and both values) and is charged against `budget.disallowedDiffs`, which has an `owner` and an `expiresAt`. After expiry the gate fails whatever the count. `exceptions` are hand-written, each naming a field and a diffHash with an owner and an expiry; a live exception covers exactly that difference. Approving the same disallowed diff twice (the same field and diffHash listed twice, a renewal included) is a config error: a difference approved repeatedly is a contract change, so set `contract.fields` for that field explicitly instead.

`agon gate shadow-diff --control control.json --variant variant.json` runs the comparison and exits 1 over budget. The CLI has no judge, so it counts a difference in a `semantic` field as material; the library function `judgeSemanticDiffs` accepts any judge. Agon does not mirror traffic into control and variant itself: produce the two outputs, then compare them.

## Top level

| field | type | required | default | description |
|---|---|---|---|---|
| `version` | `1` | yes |  |  |
| `name` | string matching `^[a-z0-9][a-z0-9_-]{0,62}$` | yes |  |  |
| `description` | string |  |  |  |
| `target` | object | yes |  |  |
| `personas` | array of object |  | `[]` | Inline persona definitions, referenced from population.personas[].use by id |
| `population` | object | yes |  |  |
| `scenarios` | array of object | yes |  |  |
| `metrics` | array of one of the variants below |  | `[]` |  |
| `analysis` | object |  | `{}` |  |
| `export` | array of one of the variants below |  | `[]` |  |
| `squad` | object |  |  | Squad credited with every variant in this config |
| `policies` | array of one of the variants below |  | `[]` |  |
| `defaults` | object |  | `{}` |  |

## `target`

| field | type | required | default | description |
|---|---|---|---|---|
| `kind` | `web` \| `http` \| `cli` \| `mcp` |  | `"web"` |  |
| `variants` | map of object | yes |  |  |
| `session` | object |  | `{}` |  |
| `capture` | object |  | `{}` |  |
| `viewport` | object |  | `{}` |  |

## `target.variants.<key>`

| field | type | required | default | description |
|---|---|---|---|---|
| `url` | url |  |  | Entry URL (web/http/mcp targets) |
| `image` | string |  |  | Container image to run for this variant (later phase) |
| `command` | string |  |  | Command to run (cli targets, and mcp servers over stdio) |
| `env` | map of string |  | `{}` |  |
| `headers` | map of string |  | `{}` |  |
| `description` | string |  |  |  |
| `squad` | string matching `^[a-z0-9][a-z0-9_-]{0,62}$` |  |  | Squad credited with this variant |
| `gitRef` | string |  |  |  |

## `target.session`

| field | type | required | default | description |
|---|---|---|---|---|
| `setup` | string |  |  | Command run before each session; its JSON stdout is passed to the user as credentials/context |
| `teardown` | string |  |  |  |
| `timeoutMs` | integer |  | `60000` |  |

## `target.capture`

| field | type | required | default | description |
|---|---|---|---|---|
| `analytics` | array of `posthog` \| `segment` \| `amplitude` \| `ga` |  | `[]` | Intercept the app's own analytics calls and attribute them to the simulated user |
| `forwardAnalytics` | boolean |  | `false` | Let intercepted analytics calls reach their real destination (default: block them) |
| `networkErrors` | boolean |  | `true` |  |
| `consoleErrors` | boolean |  | `true` |  |
| `screenshots` | `never` \| `on_decision` \| `every_step` |  | `"every_step"` |  |

## `target.viewport`

| field | type | required | default | description |
|---|---|---|---|---|
| `width` | integer |  | `1280` |  |
| `height` | integer |  | `800` |  |

## `personas[]`

| field | type | required | default | description |
|---|---|---|---|---|
| `id` | string matching `^[a-z0-9][a-z0-9_-]{0,62}$` | yes |  |  |
| `name` | string | yes |  |  |
| `summary` | string | yes |  | One paragraph, written in the second person, used verbatim in the agent prompt |
| `traits` | object | yes |  |  |
| `goals` | array of string |  | `[]` |  |
| `frustrations` | array of string |  | `[]` |  |
| `device` | `desktop` \| `mobile` \| `tablet` |  | `"desktop"` |  |
| `locale` | string |  | `"en-US"` |  |
| `harness` | object |  |  | Set when this persona is an AI agent, not a person |
| `tags` | array of string |  | `[]` |  |

## `personas[].traits`

| field | type | required | default | description |
|---|---|---|---|---|
| `role` | string | yes |  | Job or life role, e.g. "owner of a 12-person agency" |
| `techProficiency` | `novice` \| `intermediate` \| `expert` |  | `"intermediate"` |  |
| `patience` | number |  | `0.5` | Tolerance for fruitless steps before abandoning: 0 leaves at the first friction, 1 is very persistent |
| `attention` | number |  | `0.5` | Fraction of a page the user actually takes in: 0 skims headlines and buttons, 1 reads everything |
| `domainFamiliarity` | number |  | `0.5` | Prior knowledge of this product category and its jargon |
| `riskTolerance` | number |  | `0.5` | Willingness to hand over data, pay, or commit |
| `priceSensitivity` | number |  | `0.5` |  |

## `personas[].harness`

| field | type | required | default | description |
|---|---|---|---|---|
| `loop` | `react` \| `plan-execute` \| `single-shot` |  | `"react"` |  |
| `maxToolCalls` | integer |  | `20` |  |
| `retries` | integer |  | `1` | How many times the agent retries a failed tool call before changing approach |
| `parallelTools` | boolean |  | `false` |  |
| `confirmDestructive` | boolean |  | `true` | Stops to ask the user before calls that look destructive |
| `readsDescriptions` | number |  | `0.7` | How carefully tool descriptions and schemas are read: 0 guesses from names, 1 reads everything |
| `priorExposure` | number |  | `0` | Familiarity with this specific API or server |

## `population`

| field | type | required | default | description |
|---|---|---|---|---|
| `seed` | integer |  | `0` |  |
| `size` | integer | yes |  | Sessions per run, spread over variants |
| `models` | array of string matching `^[a-z0-9-]+\/[A-Za-z0-9._:-]+$` |  | `[]` | LLM backends to spread the population across; empty means defaults.model |
| `personas` | array of object | yes |  |  |
| `traitJitter` | number |  | `0.1` | Standard deviation of per-instance noise added to each persona trait |

## `population.personas[]`

| field | type | required | default | description |
|---|---|---|---|---|
| `use` | string | yes |  | "builtin/<id>" for the bundled library, a path to a persona YAML file, or the id of an inline persona in this config |
| `weight` | number |  | `1` |  |

## `scenarios[]`

| field | type | required | default | description |
|---|---|---|---|---|
| `id` | string matching `^[a-z0-9][a-z0-9_-]{0,62}$` | yes |  |  |
| `goal` | string | yes |  | What the user is trying to do, in their own words |
| `success` | string matching `^(event|url|text|check):(.+)$|^judge$` or one of the variants below | yes |  |  |
| `startPath` | string |  | `"/"` |  |
| `maxSteps` | integer |  | `30` |  |
| `budgetUsd` | number |  | `0.5` |  |
| `stallSteps` | integer |  |  | End the session with outcome "stalled" once this many consecutive steps passed without the progress hash changing. Unset (the default) disables stall detection. About 60 suits edit-heavy tasks: on 820 real coding-agent sessions the gaps between writes had p50 6, p90 21, p95 32, p99 58, max 109, so 10 would end a quarter of real stretches. Leave it unset for pollers: a poller that correctly finds nothing new is not stuck. |
| `progress` | `observation` \| `events` \| `both` |  | `"observation"` | What the progress hash covers: "observation" hashes the adapter observation after each step (URL plus page text and controls for web, tool catalog plus last tool result for mcp), "events" counts the analytics events captured so far (intercepted rows and successful tool calls), "both" treats a change in either as progress. Every action or tool call is a step. |
| `weight` | number |  | `1` |  |
| `context` | map of string |  | `{}` | Extra facts the user knows, e.g. a promo code or a colleague's referral |

## `metrics[]` with `type: conversion`

| field | type | required | default | description |
|---|---|---|---|---|
| `id` | string matching `^[a-z0-9][a-z0-9_-]{0,62}$` | yes |  |  |
| `name` | string |  |  |  |
| `primary` | boolean |  | `false` |  |
| `direction` | `increase` \| `decrease` |  |  | Which way is better; defaults per type |
| `type` | `"conversion"` | yes |  |  |
| `event` | string | yes |  |  |

## `metrics[]` with `type: count`

| field | type | required | default | description |
|---|---|---|---|---|
| `id` | string matching `^[a-z0-9][a-z0-9_-]{0,62}$` | yes |  |  |
| `name` | string |  |  |  |
| `primary` | boolean |  | `false` |  |
| `direction` | `increase` \| `decrease` |  |  | Which way is better; defaults per type |
| `type` | `"count"` | yes |  |  |
| `event` | string | yes |  |  |

## `metrics[]` with `type: duration`

| field | type | required | default | description |
|---|---|---|---|---|
| `id` | string matching `^[a-z0-9][a-z0-9_-]{0,62}$` | yes |  |  |
| `name` | string |  |  |  |
| `primary` | boolean |  | `false` |  |
| `direction` | `increase` \| `decrease` |  |  | Which way is better; defaults per type |
| `type` | `"duration"` | yes |  |  |
| `from` | string |  | `"session_start"` |  |
| `to` | string | yes |  |  |

## `metrics[]` with `type: steps`

| field | type | required | default | description |
|---|---|---|---|---|
| `id` | string matching `^[a-z0-9][a-z0-9_-]{0,62}$` | yes |  |  |
| `name` | string |  |  |  |
| `primary` | boolean |  | `false` |  |
| `direction` | `increase` \| `decrease` |  |  | Which way is better; defaults per type |
| `type` | `"steps"` | yes |  |  |

## `metrics[]` with `type: score`

| field | type | required | default | description |
|---|---|---|---|---|
| `id` | string matching `^[a-z0-9][a-z0-9_-]{0,62}$` | yes |  |  |
| `name` | string |  |  |  |
| `primary` | boolean |  | `false` |  |
| `direction` | `increase` \| `decrease` |  |  | Which way is better; defaults per type |
| `type` | `"score"` | yes |  |  |
| `source` | `judge` |  | `"judge"` |  |
| `score` | `satisfaction` \| `frustration` |  | `"satisfaction"` |  |

## `analysis`

| field | type | required | default | description |
|---|---|---|---|---|
| `method` | `bayesian` \| `sequential` \| `fixed` |  | `"bayesian"` |  |
| `control` | string matching `^[a-z0-9][a-z0-9_-]{0,62}$` |  |  | Variant treated as baseline; defaults to "control" or the first variant |
| `minSessionsPerVariant` | integer |  | `30` |  |
| `decision` | object |  | `{}` |  |
| `alpha` | number |  | `0.05` |  |
| `clusterBy` | array of `persona` \| `model` \| `scenario` |  | `["persona","model"]` | Grouping factors treated as clusters when estimating uncertainty |
| `calibrationProfile` | string |  | `"uncalibrated-v0"` |  |
| `materiality` | object |  | `{}` | The materiality boundary: output fields a decision may turn on. Versioned under the requirements digest every result carries; see docs/receipts-and-findings.md |

## `analysis.decision`

| field | type | required | default | description |
|---|---|---|---|---|
| `shipIf` | number |  | `0.95` | P(best) at or above which the variant is a ship candidate |
| `killIf` | number |  | `0.05` | P(best) at or below which the variant is a kill candidate |

## `analysis.materiality`

| field | type | required | default | description |
|---|---|---|---|---|
| `fields` | array of string |  | `[]` | Dotted paths of output fields that count as decision-relevant (e.g. "outcome", "metrics.activation", "response.total"). The shadow_diff gate treats a difference in one of them as disallowed unless its contract says otherwise; a field outside the boundary is immaterial unless the contract disallows it |
| `note` | string |  |  | Why the boundary sits where it does, e.g. the incident that moved a field in |

## `export[]` with `type: jsonl`

| field | type | required | default | description |
|---|---|---|---|---|
| `type` | `"jsonl"` | yes |  |  |
| `path` | string |  | `"./agon-out"` |  |

## `export[]` with `type: parquet`

| field | type | required | default | description |
|---|---|---|---|---|
| `type` | `"parquet"` | yes |  |  |
| `path` | string |  | `"./agon-out"` |  |

## `export[]` with `type: posthog`

| field | type | required | default | description |
|---|---|---|---|---|
| `type` | `"posthog"` | yes |  |  |
| `projectApiKey` | string | yes |  |  |
| `host` | url |  | `"https://us.i.posthog.com"` |  |
| `experimentKey` | string matching `^[a-z0-9][a-z0-9_-]{0,62}$` |  |  | Feature-flag key so PostHog Experiments can read the results |

## `export[]` with `type: amplitude`

| field | type | required | default | description |
|---|---|---|---|---|
| `type` | `"amplitude"` | yes |  |  |
| `apiKey` | string | yes |  |  |
| `serverUrl` | url |  | `"https://api2.amplitude.com/2/httpapi"` |  |

## `squad`

| field | type | required | default | description |
|---|---|---|---|---|
| `id` | string matching `^[a-z0-9][a-z0-9_-]{0,62}$` | yes |  |  |

## `policies[]` with `kind: squad`

| field | type | required | default | description |
|---|---|---|---|---|
| `kind` | `"squad"` |  | `"squad"` | The default kind: a squad governance policy (reallocate, pause, resume, kill, notify) |
| `id` | string matching `^[a-z0-9][a-z0-9_-]{0,62}$` | yes |  |  |
| `name` | string |  |  |  |
| `on` | `run.completed` \| `result.ready` \| `schedule` |  | `"result.ready"` |  |
| `when` | string |  |  | Boolean expression over squad and result metrics, e.g. "squad.p_best_rolling(5) < 0.10" |
| `then` | `reallocate` \| `pause` \| `resume` \| `kill` \| `notify` | yes |  |  |
| `method` | `thompson` |  | `"thompson"` |  |
| `floor` | number |  | `0.1` | Minimum allocation any active squad keeps |
| `approval` | `auto` \| `human` |  |  | Defaults to human for pause/kill, auto otherwise |
| `cooldown` | string matching `^\d+(ms|s|m|h|d)$` |  | `"24h"` |  |
| `maxPerDay` | integer |  | `5` |  |

## `policies[]` with `kind: protected_paths`

| field | type | required | default | description |
|---|---|---|---|---|
| `kind` | `"protected_paths"` | yes |  |  |
| `id` | string matching `^[a-z0-9][a-z0-9_-]{0,62}$` | yes |  |  |
| `name` | string |  |  |  |
| `paths` | array of string | yes |  | Globs (`*`, `**`, `?`) of paths a less-sandboxed process will later read and act on: CI workflow files, MCP server definitions, deploy manifests, lockfiles. A diff that touches one is blocked unless an approval exists for that exact diff hash |
| `approvals` | array of object |  | `[]` | Hand-written approvals, recorded against the diff hash, not the variant |
| `requireManifest` | boolean |  | `true` | Block a variant registration that carries no diff manifest. With false the check cannot run and the registration is let through; the gate is then advisory |

## `policies[] (protected_paths).approvals[]`

| field | type | required | default | description |
|---|---|---|---|---|
| `diffHash` | string | yes |  | sha256 of the exact diff text the approval covers (`agon gate protected-paths --json` prints it) |
| `approvedBy` | string | yes |  | Who approved the diff |
| `approvedAt` | ISO-8601 timestamp |  |  |  |
| `note` | string |  |  | Why the change to a protected path is acceptable |

## `policies[]` with `kind: side_effects`

| field | type | required | default | description |
|---|---|---|---|---|
| `kind` | `"side_effects"` | yes |  |  |
| `id` | string matching `^[a-z0-9][a-z0-9_-]{0,62}$` | yes |  |  |
| `name` | string |  |  |  |
| `scope` | `session` \| `tool_call` |  | `"session"` | Snapshot before and after each session, or before and after each tool call |
| `observe` | object | yes |  | Where to look. The file tree and the process table are observation points; the network is not observable and is reported as such |
| `expected` | array of string |  | `[]` | Globs of paths (and "proc:<command>" entries) allowed to change. The size of this list is recorded with every report so its growth can be measured |

## `policies[] (side_effects).observe`

| field | type | required | default | description |
|---|---|---|---|---|
| `files` | object |  |  | Snapshot the file tree under root: a content hash per file |
| `processes` | boolean |  | `false` | Snapshot the process table (unix `ps`); entries are matched as "proc:<command>" |

## `policies[] (side_effects).observe.files`

| field | type | required | default | description |
|---|---|---|---|---|
| `root` | string | yes |  | Directory to snapshot, relative to the working directory |
| `ignore` | array of string |  | `["**/node_modules/**","**/.git/**"]` | Globs never snapshotted |

## `policies[]` with `kind: shadow_diff`

| field | type | required | default | description |
|---|---|---|---|---|
| `kind` | `"shadow_diff"` | yes |  |  |
| `id` | string matching `^[a-z0-9][a-z0-9_-]{0,62}$` | yes |  |  |
| `name` | string |  |  |  |
| `contract` | object |  | `{}` | Which output fields may differ between control and variant, and how |
| `budget` | object | yes |  | A count of disallowed diffs with an expiry and a named owner |
| `exceptions` | array of object |  | `[]` | Hand-written, each with an owner and an expiry; a repeated one is a config error |

## `policies[] (shadow_diff).contract`

| field | type | required | default | description |
|---|---|---|---|---|
| `fields` | map of `allow` \| `disallow` \| `semantic` |  | `{}` | Dotted field paths (globs with `*` per segment, `**` across segments) -> allow (skipped), disallow (diffed), semantic (a judge decides whether the difference is one of meaning) |
| `default` | `allow` \| `disallow` |  | `"allow"` | Rule for fields the contract does not list and the materiality boundary does not name |

## `policies[] (shadow_diff).budget`

| field | type | required | default | description |
|---|---|---|---|---|
| `disallowedDiffs` | integer | yes |  | Disallowed diffs tolerated before the gate fails |
| `expiresAt` | ISO-8601 timestamp | yes |  | After this the budget is void and the gate fails |
| `owner` | string | yes |  | Who owns the budget, renews it or retires it |

## `policies[] (shadow_diff).exceptions[]`

| field | type | required | default | description |
|---|---|---|---|---|
| `field` | string | yes |  | Dotted path of the field the exception covers |
| `diffHash` | string | yes |  | The diffHash the gate reported for the disallowed diff |
| `owner` | string | yes |  | Who owns the exception and retires it |
| `expiresAt` | ISO-8601 timestamp | yes |  | After this the exception no longer covers the diff |
| `reason` | string |  |  |  |

## `defaults`

| field | type | required | default | description |
|---|---|---|---|---|
| `model` | string matching `^[a-z0-9-]+\/[A-Za-z0-9._:-]+$` |  | `"anthropic/claude-sonnet-5-5"` | Model used when population.models is empty |
| `judgeModel` | string matching `^[a-z0-9-]+\/[A-Za-z0-9._:-]+$` |  |  | Model for the independent judge; defaults to model |
| `temperature` | number |  | `0.7` |  |
| `maxConcurrency` | integer |  | `4` | Sessions run in parallel per target |
| `timeCapMs` | integer |  | `720000` | Wall-clock cap for the whole run in milliseconds, counted from the moment the run starts (queue time, cold start, adapter setup and session hooks all count). When reached, no new session starts, sessions in flight stop between steps, and the run ends with termination.kind = time_cap_reached: a partial result, not a failure. Default 12 minutes. |
