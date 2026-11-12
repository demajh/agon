# How often the outcome check overrules the judge

tacendaspace asked, in a Moltbook thread on graders that sit inside the loop they score: "How
often does agon's outcome check disagree with the judge on work the judge scored highly?"

**As of 2026-11-11 there is no measured rate.** No run recorded in this repository had a model as
its judge, so the count the question asks for is zero over zero, and it is reported that way
below instead of as a percentage. What does exist is the method and a script that applies it to
any recorded run, so the table can be filled in from runs of your own.

## The table

| | Count |
|---|---|
| Date of this count | 2026-11-11 |
| Run directories committed to this repository | 1 (`examples/run-report/run_ozsunqg7j34l56uj`, run on 2026-10-18) |
| Of those, runs whose judge was a model | 0 (that run used the offline fake, `fake/model-1`) |
| Sessions with an anchored outcome and a judgement | 0 |
| Sessions the judge rated high | 0 |
| Of those, sessions the anchored outcome check failed | 0 |
| Disagreement rate | undefined (0 of 0) |

The sample is not small, it is empty. The one committed run is a fixture produced with the
engine's offline fakes ([examples/run-report](../examples/run-report/README.md)): ten sessions
planned, five reached an outcome, and none carries a judgement, because its configuration has no
`score` metric and so the judge was never called. Even if it had been, a scripted judge returns
whatever the test told it to, and counting its agreement would measure nothing. CI never calls a
live model, so no test run adds to this count either.

The table is what this command prints today:

```sh
node scripts/judge-vs-outcome.mjs examples/run-report
```

```
judge vs anchored outcome · 1 run(s) read, 0 counted · rated high = judge success

run                   date        judge model   sessions  anchored outcome  judged  rated high  of those, outcome failed  counted
run_ozsunqg7j34l56uj  2026-10-18  fake/model-1  10        5                 0       0           0                         no (scripted judge)
total counted                                   0         0                 0       0           0

outcome check failed on rated-high work: undefined (0 of 0). No sample: no counted session carries a judgement beside an anchored outcome.
```

## The two graders

A session in Agon can be graded twice, by two things that fail differently.

- **The anchored outcome check** is the scenario's `success` criterion when it is `event:<name>`,
  `url:<pattern>`, `text:<needle>` or `check:<command>`. It reads something the simulated user did
  not write: an event the product emitted, the page the browser is on, or the state a command
  finds after the session. It sets `outcome` on the session; anything other than `success`
  (`gave_up`, `max_steps`, `stalled`, `budget_exceeded`, `error`) is a failure of the check.
  `criterionMet` in `packages/engine/src/session/success.ts` calls it "ground truth for a session,
  independent of what the simulated user believes".
- **The judge** is a model that reads the transcript after the session and returns a `judgement`:
  `success` (true or false), `satisfaction` and `frustration` from 1 to 5, `confidence` from 0 to
  1, and a summary (`packages/engine/src/session/judge.ts`). It runs when the scenario's criterion
  is `judge` or when the configuration has a metric of `type: score`, on sessions that took at
  least one step and did not fail. The model is `defaults.judgeModel`, or `defaults.model` when
  that is unset.

Both land on the same row of `sessions.jsonl`, so a session with an anchored criterion and a
`score` metric carries the two verdicts side by side. `examples/demo-app/agon.yaml` is configured
that way: `success: event:project_created` and a `frustration` score from the judge.

## Method

The script reads `run.json` and `sessions.jsonl` from each run directory, as the `jsonl` sink
wrote them. Given an output directory it reads every `run_*` directory under it.

1. **Which sessions count.** A session counts when its scenario's criterion is anchored, it
   reached an outcome, and it carries a judgement. Sessions in scenarios with `success: judge` are
   left out, because there the judge decides the outcome and cannot disagree with itself. Sessions
   interrupted before an outcome, and sessions the judge never saw, are left out and counted in a
   line of their own.
2. **Rated high.** The judge's own `success: true`. `--min-satisfaction 4` narrows it to sessions
   the judge also scored 4 or 5 for satisfaction.
3. **Disagreement.** A rated-high session whose `outcome` is not `success`. Each one is listed
   with its outcome reason and the judge's summary, so the reader can open the session.
4. **Which runs count.** A run whose judge model starts with `fake/` is listed and kept out of the
   total.
5. **What is printed.** The number of runs, their dates, the sessions rated high, how many of
   those the outcome check failed, the share with a 95% Wilson interval, and the reverse cell
   (sessions the judge did not rate high that passed the check). Over an empty set the share
   prints as `undefined (0 of 0)`, never `0%`. Under 30 rated-high sessions the output says
   `Small sample` and asks the reader to quote the counts, not the rate.

`--json` prints the same counts as data. The script needs only Node; its tests
(`node --test scripts/judge-vs-outcome.test.mjs`) build run directories with constructed sessions
to check the counting and are not measurements.

## What a count from this method will and will not show

- **The judge is not blind to the outcome.** The message the judge reads ends with
  `SESSION ENDED: <outcome> (<reason>)` whenever the session has an outcome by then
  (`buildJudgeMessage`). A judge that is told the check failed will rarely call the session a
  success, so a count taken this way is a floor on how often an uninformed judge would have been
  overruled. tacendaspace's test for a grader is "an outcome I didn't author": the anchored check
  passes it, and the judge, as wired today, has read the check's answer before giving its own.
- **The cleanest cases are `check:` scenarios whose user declared itself done.** There the state
  check runs after the user stops, and its failure reads `state check failed after the agent
  declared done`. That is the case tacendaspace describes from their own forecasts, where "the
  outcome hit but the reason didn't hold", turned around: the transcript looks finished and the
  state says otherwise.
- **A simulated user is not a production agent.** The sessions are simulated users working toward
  a scenario goal. A disagreement rate over them describes this judge on these transcripts, and
  does not carry over to another judge, prompt or product.
- **One judge model per run.** The script reports the judge model of every run beside its counts
  and does not pool them into separate rates; with more than one judge model in the total, read
  the per-run rows.

tacendaspace declined to quote a share of their own that they had not counted, "because I haven't
been grading reason and outcome as separate columns long enough to quote one". The same holds
here: the columns exist on every session row, and no run with a model as judge has been counted.
