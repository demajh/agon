# What a run leaves behind, and for how long

moltbookrevenueagent asked, on Moltbook: "in the agon toolkit, can per-agent series be rebuilt
from retained logs far enough back to cover the treated switch, or does the retention policy
silently choose the control for you?"

The short answer: Agon holds no access logs, so no per-agent traffic series can be rebuilt from
it, and Agon has no retention policy of its own, so nothing in it chooses a control. What it does
retain is listed below, with how long each piece lasts. The series the question is about has to
come from the operator's own server logs, and the operator's log retention is what decides how
far back a control baseline can reach.

## What is retained

Agon records **simulated** traffic: LLM-driven users with personas working through variants of a
product. Every row below describes those sessions, never real users.

| what | local mode (`agon run`) | server mode | written |
|---|---|---|---|
| **run record** | `<out>/<runId>/run.json` | `runs` row | at start, rewritten at the end with the typed `termination` |
| **recordings**: sessions, steps, events | `sessions.jsonl`, `steps.jsonl`, `events.jsonl` in the run directory, with a `manifest.json` of row counts | `sessions`, `steps`, `events` rows; `<dataDir>/runs/<runId>/sessions.jsonl` written again for the stats engine | appended as the run goes |
| **screenshots** | `<out>/<runId>/screenshots/<stepId>.png` | `<dataDir>/screenshots/<runId>/<stepId>.png`, served by `GET /v1/runs/{id}/screenshots/{stepId}` | per step, under `capture.screenshots` (`every_step`, `on_decision`, `never`) |
| **receipt** (the result, with its `requirementsDigest`) | `result.json`, written by `agon compare` | one `results` row per run, written when the run's analysis completes | once per analysis |
| **findings** | not in local mode | `findings` rows | by the repository functions; closed, never deleted |
| **ledger rows** | `<parent of out>/.agon/ledger/<sampleHash>.jsonl` | `evaluation_ledger` rows | appended at variant start, at run end, and on a ship or kill verdict |
| **decisions** | not in local mode | `decisions` rows | before any squad action |
| **LLM recordings** | `.agon/llm-cache/<key>.json` (`--llm-cache <dir>` overrides) | the same directory, relative to the server process's working directory | only in `record` mode; `live` and `off` write nothing |
| **API keys** | none | `api_keys` rows: a sha256 of the secret, a role, a label, and `last_used_at` | the timestamp is overwritten on each use |

A step's recording is the observation the simulated user saw (url, title, readable text already
truncated to the persona's attention, the interactive elements, page errors, a content hash and
the screenshot reference), the decision it made (perception, thinking, feeling, action) and the
result of the action, plus tokens and USD. Events are the analytics calls the simulated browser
made, intercepted and by default blocked before they leave the browser (`capture.analytics`),
page views and errors the adapter inferred, and the judge's verdicts; every one carries
`agon_simulated: true`, and the exporters refuse one that does not
([results-contract.md](results-contract.md)). Each simulated user has a stable
`persona.distinctId`, so a per-agent event series does exist in `events.jsonl`, for simulated
agents only, and only for the run that produced them.

## For how long

Agon has no retention policy. Nothing expires, rotates or is deleted on a schedule: there is no
TTL, no `keep_days`, no clean-up job. What is written stays until someone removes it.

- **Local mode.** Everything lives under the output directory (`-o`, `$AGON_OUT_DIR`, default
  `./agon-out`) and the `.agon/` directory beside it. They last as long as the directories do.
  `agon compare` rewrites `result.json` on every run, so an old receipt survives only if the
  file is kept ([receipts-and-findings.md](receipts-and-findings.md)).
- **Server mode.** Rows last as long as the database. The one deleting route,
  `DELETE /v1/environments/{id}`, removes the environment and, through foreign keys, its variants,
  runs, sessions, steps, events and results. It does not touch the evaluation ledger, findings or
  decisions: their `run_id`, `receipt_id` and `squad_id` are deliberately not foreign keys, so a
  trial still counts, a finding still names its receipt and a decision still names its squad after
  the rows they pointed at are gone. It also does not remove files under `<dataDir>`
  (`AGON_DATA_DIR`, default `.agon/data`): screenshots, the per-run `sessions.jsonl` and
  `result.json` the stats engine was given, and anything a file sink wrote under
  `<dataDir>/exports`. Those stay until the volume is cleared (`agondata` and `pgdata` in
  `compose.yaml` persist across restarts). API keys are revoked, never deleted. The job queue's
  rows (pg-boss) carry only the run id and are pruned by pg-boss on its own schedule; nothing
  about a run lives or dies with them.
- **Exports.** PostHog, Amplitude and warehouse sinks hand the rows to another system, whose
  retention then applies. Agon keeps no copy of what it sent beyond the rows above.

So the reach of a receipt or a ledger row is exactly the age of the directory or database that
holds it. The ledger is designed to outlive its run; nothing is designed to outlive the store.

## What Agon does not hold

- **The target's logs.** The web adapter watches the simulated browser from inside: console
  errors, failed requests, responses of 400 and above, navigations, and the analytics calls it
  intercepts. It never reads the target's server logs, request logs or metrics, and it keeps no
  HAR or network trace. The MCP adapter records the tool calls the simulated agent made and
  nothing about the server's other callers.
- **Real traffic.** Nothing in Agon captures live users. Every event it records is one it caused
  and stamped as simulated, so that the real population can exclude it. The inverse problem
  moltbookrevenueagent describes, a counter that was accurate at every timestamp while 1,233 of
  its 1,256 rows were their own cron, is not one Agon can mark: it stamps its own traffic, not
  anybody else's.
- **Access logs of its own API.** The server logs one `pino` debug line per request (method,
  path, status, duration) to its process output, which is not stored anywhere by Agon. The only
  persisted trace of a caller is `last_used_at` on an API key, a single timestamp that each use
  overwrites.
- **Live windows.** `agon live-window` compares two JSON files exported from the operator's
  metrics system and stores neither; the server has no route for live-window reports
  ([live-window-recorder.md](live-window-recorder.md)).

This is why the question has to be answered outside the toolkit. A per-agent traffic series over
the days around a treated switch is a function of the server's access logs, and those logs are
retained by whoever runs the server. If they reach back to a matched-capacity window before the
switch, that window can be the control baseline; if they do not, the baseline is whatever is left,
and the choice was made by the log retention, not by anyone's design. Agon's part is to say
plainly that it holds nothing that would widen that reach.

## How far back a recorded live window can be replayed

A recorded live window can be replayed exactly as far back as its two files, the baseline and the
live JSON, still exist: `agon live-window --baseline baseline.json --live live.json` reads only
them, and because the bootstrap is seeded (`--seed`, default 0), the same files and parameters
give the same report however long after the release they are run. Likewise `agon trace <run dir>
<session>` replays a simulated session from `sessions.jsonl` and `steps.jsonl` for as long as the
run directory exists, and `GET /v1/sessions/{id}/trace` does the same from the database.

## Checking what a run left

```sh
agon trace ./agon-out                 # lists the sessions of the newest run under the directory
cat ./agon-out/<runId>/manifest.json  # every file the JSONL sink wrote, with row counts and bytes
agon ledger ./agon-out/<runId>        # every ledger entry against the run's sample, M included
```
