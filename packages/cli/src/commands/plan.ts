import { dirname, resolve } from 'node:path';
import { planSessions, resolvePersonas } from '@agon/engine';
import { ConfigError, isAgonError, readAgonConfig } from '@agon/spec';
import { formatUsd, type Output } from '../output.js';

export interface PlanOptions {
  file: string;
  variants?: string[] | undefined;
  seed?: number | undefined;
  size?: number | undefined;
  env?: Record<string, string | undefined>;
}

/** Shows exactly which sessions a run would execute, without touching a browser or a model. */
export function planCommand(out: Output, options: PlanOptions): number {
  const path = resolve(options.file);
  try {
    const config = readAgonConfig(path, { env: options.env ?? process.env });
    const variants = options.variants ?? Object.keys(config.target.variants);
    for (const v of variants) {
      if (!config.target.variants[v])
        throw new ConfigError(
          `unknown variant "${v}" (have: ${Object.keys(config.target.variants).join(', ')})`,
        );
    }
    const seed = options.seed ?? config.population.seed;
    const size = options.size ?? config.population.size;
    const personas = resolvePersonas(config, { cwd: dirname(path) });
    const plans = planSessions(config, personas, {
      runId: 'run_plan',
      variants,
      seed,
      size,
      defaultModel: config.defaults.model,
    });

    const count = <K extends string>(keys: K[]): Record<K, number> =>
      keys.reduce<Record<K, number>>(
        (acc, k) => ({ ...acc, [k]: (acc[k] ?? 0) + 1 }),
        {} as Record<K, number>,
      );
    const byVariant = count(plans.map((p) => p.variant));
    const byPersona = count(plans.map((p) => p.persona.personaId));
    const byScenario = count(plans.map((p) => p.scenario.id));
    const byModel = count(plans.map((p) => p.persona.model));
    const worstCaseUsd = plans.reduce((sum, p) => sum + p.scenario.budgetUsd, 0);

    if (out.options.json) {
      out.json({
        seed,
        size,
        variants,
        byVariant,
        byPersona,
        byScenario,
        byModel,
        worstCaseUsd,
        sessions: plans.map((p) => ({
          index: p.index,
          variant: p.variant,
          scenario: p.scenario.id,
          persona: p.persona.personaId,
          model: p.persona.model,
          device: p.persona.device,
        })),
      });
      return 0;
    }
    out.heading(`${config.name}: ${plans.length} sessions (seed ${seed})`);
    const dist = (label: string, counts: Record<string, number>): void =>
      out.text(
        `  ${label}: ${Object.entries(counts)
          .map(([k, n]) => `${k} ${n}`)
          .join(', ')}`,
      );
    dist('variants', byVariant);
    dist('personas', byPersona);
    dist('scenarios', byScenario);
    dist('models', byModel);
    out.text(`  worst-case LLM spend: ${formatUsd(worstCaseUsd)} (sum of scenario budgets)`);
    out.text();
    out.table(
      ['#', 'variant', 'scenario', 'persona', 'model', 'device', 'patience', 'attention'],
      plans
        .slice(0, 20)
        .map((p) => [
          p.index,
          p.variant,
          p.scenario.id,
          p.persona.personaId,
          p.persona.model,
          p.persona.device,
          p.persona.traits.patience.toFixed(2),
          p.persona.traits.attention.toFixed(2),
        ]),
    );
    if (plans.length > 20) out.text(out.dim(`  … ${plans.length - 20} more (use --json for all)`));
    return 0;
  } catch (error) {
    const message = isAgonError(error) ? error.message : String(error);
    if (out.options.json) out.json({ ok: false, error: message });
    else out.fail(message);
    return 1;
  }
}
