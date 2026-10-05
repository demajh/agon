import {
  SCENARIO_SUCCESS_METRIC_ID,
  type AgonConfig,
  type AgonEvent,
  type Session,
} from '@agon/spec';

type MetricInputs = Pick<Session, 'outcome' | 'steps' | 'startedAt' | 'judgement'>;

/** Metric values for one finished session, keyed by metric id. `scenario_success` is always present. */
export function computeSessionMetrics(
  config: AgonConfig,
  session: MetricInputs,
  events: readonly AgonEvent[],
): Record<string, number> {
  const out: Record<string, number> = {
    [SCENARIO_SUCCESS_METRIC_ID]: session.outcome === 'success' ? 1 : 0,
  };
  const firstEvent = (name: string): AgonEvent | undefined => events.find((e) => e.event === name);
  for (const metric of config.metrics) {
    switch (metric.type) {
      case 'conversion':
        out[metric.id] = firstEvent(metric.event) ? 1 : 0;
        break;
      case 'count':
        out[metric.id] = events.filter((e) => e.event === metric.event).length;
        break;
      case 'duration': {
        const from =
          metric.from === 'session_start' ? session.startedAt : firstEvent(metric.from)?.timestamp;
        const to = firstEvent(metric.to)?.timestamp;
        if (from && to) out[metric.id] = Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000);
        break;
      }
      case 'steps':
        out[metric.id] = session.steps;
        break;
      case 'score':
        if (session.judgement) out[metric.id] = session.judgement[metric.score];
        break;
    }
  }
  return out;
}
