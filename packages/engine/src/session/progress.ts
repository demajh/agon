import {
  INFERRED_EVENTS,
  ValidationError,
  type AgonEvent,
  type Observation,
  type ProgressSignal,
  type Session,
} from '@agon/spec';

/**
 * Events that mean "a new successful row landed": the target's own analytics calls that the
 * adapter intercepted, and tool calls that did not error. Engine bookkeeping events (session
 * start, pageviews, clicks, abandon) are not progress by themselves.
 */
export function countProgressEvents(events: readonly AgonEvent[]): number {
  let n = 0;
  for (const event of events) {
    if (event.source === 'intercepted') n++;
    else if (event.event === INFERRED_EVENTS.toolCall && event.properties['is_error'] !== true) n++;
  }
  return n;
}

/**
 * The progress hash of a session state, per `scenarios[].progress`: the adapter's observation
 * hash (URL plus page text and controls for web, catalog plus last tool result for mcp), the
 * number of progress events captured so far, or both.
 */
export function progressHash(
  signal: ProgressSignal,
  observation: Observation,
  events: readonly AgonEvent[],
): string {
  switch (signal) {
    case 'observation':
      return `o:${observation.hash}`;
    case 'events':
      return `e:${countProgressEvents(events)}`;
    case 'both':
      return `o:${observation.hash}|e:${countProgressEvents(events)}`;
  }
}

/**
 * Per-session progress bookkeeping. Every action is a step; a step made progress when the hash
 * observed after it differs from the hash observed before it. `stepsSinceProgress` counts the
 * consecutive steps without progress and resets to 0 when the hash changes.
 */
export class ProgressTracker {
  stepsSinceProgress = 0;
  maxStepsSinceProgress = 0;
  /** Steps taken when progress was last observed; 0 when never. */
  lastProgressStep = 0;
  /** Step counts after which progress was observed, in order. */
  readonly progressSteps: number[] = [];
  private lastHash: string | undefined;

  /**
   * Records the state observed after `stepsTaken` steps. The first call (before any step) only
   * seeds the hash and is never progress. Returns whether this observation counted as progress.
   */
  observe(hash: string, stepsTaken: number): boolean {
    if (this.lastHash === undefined) {
      this.lastHash = hash;
      return false;
    }
    const progressed = hash !== this.lastHash;
    this.lastHash = hash;
    if (progressed) {
      this.stepsSinceProgress = 0;
      this.lastProgressStep = stepsTaken;
      this.progressSteps.push(stepsTaken);
    } else {
      this.stepsSinceProgress++;
      this.maxStepsSinceProgress = Math.max(this.maxStepsSinceProgress, this.stepsSinceProgress);
    }
    return progressed;
  }

  /** True once `stallSteps` consecutive steps passed without progress; never with it unset. */
  stalled(stallSteps: number | undefined): boolean {
    return stallSteps !== undefined && this.stepsSinceProgress >= stallSteps;
  }

  /** The fields recorded on the session. */
  summary(): Pick<Session, 'maxStepsSinceProgress' | 'lastProgressStep' | 'progressSteps'> {
    return {
      maxStepsSinceProgress: this.maxStepsSinceProgress,
      lastProgressStep: this.lastProgressStep,
      progressSteps: [...this.progressSteps],
    };
  }
}

export type StallGapInput = Pick<Session, 'steps' | 'progressSteps'>;

/** Distribution of the gaps between progress events across the sessions of a run. */
export interface StallGapReport {
  sessions: number;
  sessionsWithProgress: number;
  /** Complete gaps: steps between consecutive progress events, the first counted from step 0. */
  gaps: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  over10: number;
  over60: number;
  /** Steps after the last progress event at session end: censored, so reported separately. */
  tails: { count: number; max: number };
}

/** Nearest-rank quantile of an ascending array; 0 for an empty one. */
export function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1] as number;
}

/**
 * Computes the gap distribution. Throws unless at least two sessions were given and at least one
 * carries progress data, so a format mismatch fails instead of printing an empty report.
 */
export function stallGaps(sessions: readonly StallGapInput[]): StallGapReport {
  if (sessions.length < 2) {
    throw new ValidationError(
      `stall report needs at least 2 recorded sessions, got ${sessions.length}; check that the run directory holds a sessions.jsonl in the current format`,
    );
  }
  if (sessions.every((s) => s.progressSteps === undefined)) {
    throw new ValidationError(
      `none of the ${sessions.length} sessions carry progress data (progressSteps); the run was recorded before stall tracking existed or the file is not a sessions.jsonl`,
    );
  }
  const gaps: number[] = [];
  let sessionsWithProgress = 0;
  let tailCount = 0;
  let tailMax = 0;
  for (const session of sessions) {
    const progress = [...new Set(session.progressSteps ?? [])].sort((a, b) => a - b);
    if (progress.length > 0) sessionsWithProgress++;
    let previous = 0;
    for (const step of progress) {
      gaps.push(step - previous);
      previous = step;
    }
    const tail = session.steps - previous;
    if (tail > 0) {
      tailCount++;
      tailMax = Math.max(tailMax, tail);
    }
  }
  const sorted = [...gaps].sort((a, b) => a - b);
  return {
    sessions: sessions.length,
    sessionsWithProgress,
    gaps: gaps.length,
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: sorted.at(-1) ?? 0,
    over10: gaps.filter((g) => g > 10).length,
    over60: gaps.filter((g) => g > 60).length,
    tails: { count: tailCount, max: tailMax },
  };
}
