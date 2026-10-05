# agon.yaml reference

Generated from the Zod schema in `@agon/spec` by `scripts/gen-config-docs.mjs`. Do not edit by hand; run `pnpm docs:config`.

Strings may contain `${ENV_VAR}` or `${ENV_VAR:-default}`; missing variables without a default fail validation. Keys you choose (variants, scenarios, metrics, personas, policies) are slugs: lowercase letters, digits, `-` and `_`.

`scenarios[].success` accepts the shorthand strings `event:<name>`, `url:<pattern>`, `text:<needle>` or `judge`, or the object form documented below.

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
| `policies` | array of object |  | `[]` |  |
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
| `command` | string |  |  | Command to run (cli targets) |
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
| `success` | string matching `^(event|url|text):(.+)$|^judge$` or one of the variants below | yes |  |  |
| `startPath` | string |  | `"/"` |  |
| `maxSteps` | integer |  | `30` |  |
| `budgetUsd` | number |  | `0.5` |  |
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

## `analysis.decision`

| field | type | required | default | description |
|---|---|---|---|---|
| `shipIf` | number |  | `0.95` | P(best) at or above which the variant is a ship candidate |
| `killIf` | number |  | `0.05` | P(best) at or below which the variant is a kill candidate |

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

## `policies[]`

| field | type | required | default | description |
|---|---|---|---|---|
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

## `defaults`

| field | type | required | default | description |
|---|---|---|---|---|
| `model` | string matching `^[a-z0-9-]+\/[A-Za-z0-9._:-]+$` |  | `"anthropic/claude-sonnet-5-5"` | Model used when population.models is empty |
| `judgeModel` | string matching `^[a-z0-9-]+\/[A-Za-z0-9._:-]+$` |  |  | Model for the independent judge; defaults to model |
| `temperature` | number |  | `0.7` |  |
| `maxConcurrency` | integer |  | `4` | Sessions run in parallel per target |
