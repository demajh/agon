import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  RunSchema,
  SessionSchema,
  StepSchema,
  isAgonError,
  type Run,
  type Session,
  type Step,
} from '@agon/spec';
import type { z } from 'zod';
import { describeAction } from '@agon/engine';
import { formatUsd, type Output } from '../output.js';

export interface TraceOptions {
  /** A run directory (`…/agon-out/<runId>`) or an output directory holding several runs. */
  dir: string;
  /** Session id, unique id suffix, or zero-based index. Omit to list sessions. */
  sessionId?: string | undefined;
  limit?: number | undefined;
}

function readJsonl<T>(path: string, schema: z.ZodType<T>): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => schema.parse(JSON.parse(line)));
}

/** Accepts a run directory or an output directory; in the latter case picks the newest run. */
export function resolveRunDir(input: string): string {
  const dir = resolve(input);
  if (existsSync(join(dir, 'run.json'))) return dir;
  if (!existsSync(dir) || !statSync(dir).isDirectory())
    throw new Error(`${dir} is not a run directory`);
  const runs = readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((p) => existsSync(join(p, 'run.json')))
    .map((p) => ({
      p,
      createdAt: RunSchema.parse(JSON.parse(readFileSync(join(p, 'run.json'), 'utf8'))).createdAt,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const newest = runs[0];
  if (!newest) throw new Error(`no runs found under ${dir} (expected <dir>/<runId>/run.json)`);
  return newest.p;
}

function findSession(sessions: Session[], key: string): Session | undefined {
  return (
    sessions.find((s) => s.id === key) ??
    sessions.find((s) => String(s.index) === key.replace(/^#/, '')) ??
    sessions.find((s) => s.id.endsWith(key))
  );
}

export function traceCommand(out: Output, options: TraceOptions): number {
  try {
    const runDir = resolveRunDir(options.dir);
    const run: Run = RunSchema.parse(JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')));
    const sessions = readJsonl(join(runDir, 'sessions.jsonl'), SessionSchema).sort(
      (a, b) => a.index - b.index,
    );

    if (!options.sessionId) {
      const shown = sessions.slice(0, options.limit ?? 50);
      if (out.options.json) {
        out.json({ runDir, run, sessions });
        return 0;
      }
      out.heading(
        `${run.id} ${run.status} · ${run.config.name} · ${sessions.length} sessions · ${formatUsd(run.costUsd)}`,
      );
      out.table(
        ['#', 'session', 'variant', 'persona', 'outcome', 'steps', 'cost', 'reason'],
        shown.map((s) => [
          s.index,
          s.id,
          s.variant,
          s.persona.personaId,
          s.outcome ?? '-',
          s.steps,
          formatUsd(s.costUsd),
          (s.outcomeReason ?? '').slice(0, 60),
        ]),
      );
      if (sessions.length > shown.length)
        out.text(out.dim(`  … ${sessions.length - shown.length} more (use --limit)`));
      out.text(out.dim(`  agon trace ${runDir} <#|session id> to replay one session`));
      return 0;
    }

    const session = findSession(sessions, options.sessionId);
    if (!session) {
      out.fail(`no session "${options.sessionId}" in ${runDir} (${sessions.length} sessions)`);
      return 1;
    }
    const steps: Step[] = readJsonl(join(runDir, 'steps.jsonl'), StepSchema)
      .filter((s) => s.sessionId === session.id)
      .sort((a, b) => a.index - b.index);
    if (out.options.json) {
      out.json({ runDir, session, steps });
      return 0;
    }
    out.heading(
      `${session.id} · ${session.variant} · ${session.persona.name} (${session.persona.personaId}, ${session.persona.model})`,
    );
    out.text(
      `  goal: ${run.config.scenarios.find((s) => s.id === session.scenarioId)?.goal.trim() ?? session.scenarioId}`,
    );
    out.text();
    for (const step of steps) {
      const d = step.decision;
      out.text(
        `#${step.index + 1}  ${step.observation.url}  ${out.dim(`felt ${d.feeling} · ${d.progress} · patience ${step.patience.toFixed(2)}`)}`,
      );
      out.text(`    sees:   ${d.perception}`);
      out.text(`    thinks: ${d.thinking}`);
      out.text(
        `    does:   ${describeAction(d.action)} → ${step.result.ok ? (step.result.navigated ? 'ok, page changed' : 'ok') : `failed: ${step.result.error ?? 'unknown'}`}`,
      );
    }
    out.text();
    out.text(
      `  outcome: ${session.outcome ?? '-'}${session.outcomeReason ? ` (${session.outcomeReason})` : ''} · ${session.steps} steps · ${formatUsd(session.costUsd)}`,
    );
    if (session.judgement) {
      out.text(
        `  judge: ${session.judgement.success ? 'success' : 'not successful'}, satisfaction ${session.judgement.satisfaction}/5, frustration ${session.judgement.frustration}/5 — ${session.judgement.summary}`,
      );
    }
    const metrics = Object.entries(session.metrics);
    if (metrics.length)
      out.text(
        `  metrics: ${metrics.map(([k, v]) => `${k}=${Number.isInteger(v) ? v : v.toFixed(2)}`).join(', ')}`,
      );
    return 0;
  } catch (error) {
    const message = isAgonError(error)
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
    if (out.options.json) out.json({ ok: false, error: message });
    else out.fail(message);
    return 1;
  }
}
