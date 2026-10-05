import { resolve } from 'node:path';
import { controlVariant, isAgonError, readAgonConfig, type AgonConfig } from '@agon/spec';
import type { Output } from '../output.js';

export interface ValidateOptions {
  file: string;
  env?: Record<string, string | undefined>;
}

export interface ValidateResult {
  ok: boolean;
  config?: AgonConfig;
  error?: string;
}

/** Parses and validates an agon.yaml and prints a short summary of what it describes. */
export function validateCommand(out: Output, options: ValidateOptions): ValidateResult {
  const path = resolve(options.file);
  let config: AgonConfig;
  try {
    config = readAgonConfig(path, { env: options.env ?? process.env });
  } catch (error) {
    const message = isAgonError(error) ? error.message : String(error);
    if (out.options.json) out.json({ ok: false, file: path, error: message });
    else out.fail(message);
    return { ok: false, error: message };
  }
  if (out.options.json) {
    out.json({ ok: true, file: path, config });
    return { ok: true, config };
  }
  const variants = Object.keys(config.target.variants);
  out.ok(`${path} is valid`);
  out.text(
    `  ${config.name}: ${config.target.kind} target, ${variants.length} variant(s) [${variants.join(', ')}], control = ${controlVariant(config)}`,
  );
  out.text(
    `  population: ${config.population.size} sessions, seed ${config.population.seed}, ${config.population.personas.length} persona ref(s), models: ${config.population.models.length ? config.population.models.join(', ') : config.defaults.model}`,
  );
  out.text(
    `  scenarios: ${config.scenarios.map((s) => `${s.id} (≤${s.maxSteps} steps, ≤$${s.budgetUsd})`).join('; ')}`,
  );
  out.text(
    `  metrics: scenario_success${config.metrics.length ? ', ' + config.metrics.map((m) => `${m.id}${m.primary ? '*' : ''}`).join(', ') : ''}`,
  );
  out.text(
    `  analysis: ${config.analysis.method}, min ${config.analysis.minSessionsPerVariant}/variant, ship ≥ ${config.analysis.decision.shipIf}, kill ≤ ${config.analysis.decision.killIf}`,
  );
  out.text(
    `  export: ${config.export.length ? config.export.map((e) => e.type).join(', ') : 'none'}`,
  );
  return { ok: true, config };
}
