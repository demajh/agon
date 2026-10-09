import type { AgonEvent, Session, WarehouseStamp } from '@agon/spec';
import { SCENARIO_SUCCESS_METRIC_ID, stampWarehouseRow } from '@agon/spec';
import { readMarkers } from './exporter.js';

/**
 * Flat row shapes of the warehouse tables (`agon_sessions`, `agon_events`, `agon_exposures`,
 * `agon_metric_values`). Timestamps are ISO-8601 strings for portability across loaders.
 * The exposure and metric-value shapes follow the assignment/metric-source tables that
 * GrowthBook and Statsig read in warehouse-native mode.
 *
 * Every row carries the results contract stamp (`schema_version`, `required_set`): the id of the
 * field list a consumer may rely on, resolved through the registry in `@agon/spec`
 * (docs/results-contract.md). Row builders stamp at write time and refuse to stamp a row that
 * lacks a field of its set.
 */
export interface SessionRow extends WarehouseStamp {
  session_id: string;
  run_id: string;
  index: number;
  variant: string;
  scenario_id: string;
  persona_id: string;
  model: string;
  device: string;
  outcome: string | null;
  outcome_reason: string | null;
  steps: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  started_at: string | null;
  finished_at: string | null;
  judge_success: boolean | null;
  judge_satisfaction: number | null;
  judge_frustration: number | null;
  /** `session.metrics` serialized as a JSON object string. */
  metrics_json: string;
}

export interface EventRow extends WarehouseStamp {
  event_id: string;
  run_id: string;
  session_id: string;
  timestamp: string;
  event: string;
  distinct_id: string;
  source: string;
  provider: string | null;
  variant: string;
  persona_id: string;
  model: string;
  /** Full event properties (simulation markers included) as a JSON object string. */
  properties_json: string;
}

export interface ExposureRow extends WarehouseStamp {
  session_id: string;
  run_id: string;
  variant: string;
  experiment_key: string;
  exposed_at: string | null;
}

export interface MetricValueRow extends WarehouseStamp {
  session_id: string;
  run_id: string;
  variant: string;
  metric_id: string;
  value: number;
}

export function sessionRow(session: Session): SessionRow {
  return stampWarehouseRow('session_row', {
    session_id: session.id,
    run_id: session.runId,
    index: session.index,
    variant: session.variant,
    scenario_id: session.scenarioId,
    persona_id: session.persona.personaId,
    model: session.persona.model,
    device: session.persona.device,
    outcome: session.outcome ?? null,
    outcome_reason: session.outcomeReason ?? null,
    steps: session.steps,
    cost_usd: session.costUsd,
    input_tokens: session.inputTokens,
    output_tokens: session.outputTokens,
    started_at: session.startedAt ?? null,
    finished_at: session.finishedAt ?? null,
    judge_success: session.judgement?.success ?? null,
    judge_satisfaction: session.judgement?.satisfaction ?? null,
    judge_frustration: session.judgement?.frustration ?? null,
    metrics_json: JSON.stringify(session.metrics),
  });
}

/** Throws `ValidationError` for an event without simulation markers. */
export function eventRow(event: AgonEvent): EventRow {
  const markers = readMarkers(event);
  return stampWarehouseRow('event_row', {
    event_id: event.id,
    run_id: event.runId,
    session_id: event.sessionId,
    timestamp: event.timestamp,
    event: event.event,
    distinct_id: event.distinctId,
    source: event.source,
    provider: event.provider ?? null,
    variant: markers.agon_variant,
    persona_id: markers.agon_persona,
    model: markers.agon_model,
    properties_json: JSON.stringify(event.properties),
  });
}

export function exposureRow(session: Session, experimentKey: string): ExposureRow {
  return stampWarehouseRow('exposure_row', {
    session_id: session.id,
    run_id: session.runId,
    variant: session.variant,
    experiment_key: experimentKey,
    exposed_at: session.startedAt ?? null,
  });
}

/**
 * One row per computed metric plus `scenario_success` derived from the outcome. The derived row
 * replaces any same-named entry in `session.metrics` so each metric id appears exactly once.
 */
export function metricValueRows(session: Session): MetricValueRow[] {
  const base = { session_id: session.id, run_id: session.runId, variant: session.variant };
  const rows = Object.entries(session.metrics)
    .filter(([metricId]) => metricId !== SCENARIO_SUCCESS_METRIC_ID)
    .map(([metricId, value]) =>
      stampWarehouseRow('metric_value_row', { ...base, metric_id: metricId, value }),
    );
  rows.push(
    stampWarehouseRow('metric_value_row', {
      ...base,
      metric_id: SCENARIO_SUCCESS_METRIC_ID,
      value: session.outcome === 'success' ? 1 : 0,
    }),
  );
  return rows;
}
