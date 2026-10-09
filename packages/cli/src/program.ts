import { Command } from 'commander';
import { personasListCommand, personasShowCommand } from './commands/personas.js';
import { compareCommand } from './commands/compare.js';
import { protectedPathsCommand, shadowDiffCommand } from './commands/gate.js';
import { liveWindowCommand } from './commands/live-window.js';
import { planCommand } from './commands/plan.js';
import { runCommand } from './commands/run.js';
import { ledgerCommand } from './commands/ledger.js';
import { schemaCommand } from './commands/schema.js';
import { stallReportCommand } from './commands/stall-report.js';
import { traceCommand } from './commands/trace.js';
import { validateCommand } from './commands/validate.js';
import { Output } from './output.js';

export const CLI_VERSION = '0.0.1';

export interface ProgramDeps {
  write?: (text: string) => void;
  exit?: (code: number) => void;
}

/** Builds the `agon` command tree. Kept separate from bin.ts so tests can drive it in-process. */
export function createProgram(deps: ProgramDeps = {}): Command {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const program = new Command('agon')
    .description('Simulated-user experiments for software built by agents.')
    .version(CLI_VERSION)
    .option('--json', 'machine-readable output', false)
    .option('--no-color', 'disable colors')
    .exitOverride()
    .configureOutput({
      writeOut: (s) => (deps.write ?? ((t: string) => process.stdout.write(t)))(s),
    });

  const output = (): Output => {
    const opts = program.opts<{ json: boolean; color: boolean }>();
    return new Output({ json: opts.json, color: opts.color && !opts.json }, deps.write);
  };

  program
    .command('validate')
    .description('Validate an agon.yaml and summarize what it describes')
    .argument('[file]', 'path to agon.yaml', 'agon.yaml')
    .action((file: string) => {
      exit(validateCommand(output(), { file }).ok ? 0 : 1);
    });

  program
    .command('plan')
    .description('Show the sessions a run would execute, without running anything')
    .argument('[file]', 'path to agon.yaml', 'agon.yaml')
    .option('-v, --variant <name...>', 'only these variants')
    .option('-s, --seed <n>', 'override population.seed', (v) => Number.parseInt(v, 10))
    .option('-n, --size <n>', 'override population.size', (v) => Number.parseInt(v, 10))
    .action((file: string, opts: { variant?: string[]; seed?: number; size?: number }) => {
      exit(
        planCommand(output(), { file, variants: opts.variant, seed: opts.seed, size: opts.size }),
      );
    });

  program
    .command('run')
    .description('Run an experiment: simulate the population against every variant and record it')
    .argument('[file]', 'path to agon.yaml', 'agon.yaml')
    .option('-v, --variant <name...>', 'only these variants')
    .option('-s, --seed <n>', 'override population.seed', (v) => Number.parseInt(v, 10))
    .option('-n, --size <n>', 'override population.size', (v) => Number.parseInt(v, 10))
    .option('-m, --model <ref>', 'override defaults.model, e.g. anthropic/claude-sonnet-5-5')
    .option(
      '-c, --concurrency <n>',
      'sessions in parallel (default defaults.maxConcurrency)',
      (v) => Number.parseInt(v, 10),
    )
    .option(
      '--time-cap-ms <n>',
      'wall-clock cap for the whole run in ms (default defaults.timeCapMs, 720000); exit code 3 when reached',
      (v) => Number.parseInt(v, 10),
    )
    .option('-o, --out <dir>', 'output directory (default ./agon-out or $AGON_OUT_DIR)')
    .option(
      '--ledger-dir <dir>',
      'evaluation ledger directory (default <parent of out>/.agon/ledger)',
    )
    .option('--llm-mode <mode>', 'live | record | replay | off (default $AGON_LLM_MODE or live)')
    .option('--llm-cache <dir>', 'record/replay cache directory (default .agon/llm-cache)')
    .option('--headful', 'show the browser while it runs', false)
    .option('--dry-run', 'plan the sessions and write the run record without executing', false)
    .option('--log-level <level>', 'diagnostics level on stderr (default warn)')
    .action(
      async (
        file: string,
        opts: {
          variant?: string[];
          seed?: number;
          size?: number;
          model?: string;
          concurrency?: number;
          timeCapMs?: number;
          out?: string;
          ledgerDir?: string;
          llmMode?: string;
          llmCache?: string;
          headful: boolean;
          dryRun: boolean;
          logLevel?: string;
        },
      ) => {
        exit(
          await runCommand(output(), {
            file,
            variants: opts.variant,
            seed: opts.seed,
            size: opts.size,
            model: opts.model,
            concurrency: opts.concurrency,
            timeCapMs: opts.timeCapMs,
            out: opts.out,
            ledgerDir: opts.ledgerDir,
            llmMode: opts.llmMode,
            llmCacheDir: opts.llmCache,
            headful: opts.headful,
            dryRun: opts.dryRun,
            logLevel: opts.logLevel,
          }),
        );
      },
    );

  program
    .command('compare')
    .description('Analyze a recorded run with agon-stats and write result.json next to it')
    .argument('<dir>', 'run directory (…/agon-out/<runId>) or an output directory (newest run)')
    .option('--method <method>', 'bayesian | sequential | fixed (default from the config)')
    .option('--control <variant>', 'baseline variant (default from the config)')
    .option('--min-sessions <n>', 'override analysis.minSessionsPerVariant', (v) =>
      Number.parseInt(v, 10),
    )
    .option('--profile <name>', 'calibration profile (default from the config)')
    .option(
      '--category <name>',
      'change category for the calibration note, e.g. copy, layout, flow, pricing',
    )
    .option('--seed <n>', 'Monte Carlo / bootstrap seed (default the run seed)', (v) =>
      Number.parseInt(v, 10),
    )
    .option('--ledger-dir <dir>', 'evaluation ledger directory (default next to the run output)')
    .action(
      async (
        dir: string,
        opts: {
          method?: 'bayesian' | 'sequential' | 'fixed';
          control?: string;
          minSessions?: number;
          profile?: string;
          category?: string;
          seed?: number;
          ledgerDir?: string;
        },
      ) => {
        exit(
          await compareCommand(output(), {
            dir,
            method: opts.method,
            control: opts.control,
            minSessions: opts.minSessions,
            profile: opts.profile,
            category: opts.category,
            seed: opts.seed,
            ledgerDir: opts.ledgerDir,
          }),
        );
      },
    );

  program
    .command('ledger')
    .description(
      'Print the evaluation ledger of a run or sample hash: how many distinct variants were ever evaluated against that sample (M), and every entry',
    )
    .argument('<target>', 'run directory, output directory (newest run), or a sample hash prefix')
    .option(
      '--ledger-dir <dir>',
      'evaluation ledger directory (default next to the run output, or .agon/ledger)',
    )
    .action(async (target: string, opts: { ledgerDir?: string }) => {
      exit(await ledgerCommand(output(), { target, ledgerDir: opts.ledgerDir }));
    });

  program
    .command('trace')
    .description('Inspect a recorded run: list its sessions, or replay one step by step')
    .argument('<dir>', 'run directory (…/agon-out/<runId>) or an output directory (newest run)')
    .argument('[session]', 'session id, id suffix, or index')
    .option('--limit <n>', 'sessions to list', (v) => Number.parseInt(v, 10))
    .action((dir: string, session: string | undefined, opts: { limit?: number }) => {
      exit(traceCommand(output(), { dir, sessionId: session, limit: opts.limit }));
    });

  program
    .command('stall-report')
    .description(
      'Distribution of the gaps between progress events across the sessions of a recorded run, for choosing stallSteps',
    )
    .argument('<dir>', 'run directory (…/agon-out/<runId>) or an output directory (newest run)')
    .action((dir: string) => {
      exit(stallReportCommand(output(), { dir }));
    });

  const int = (v: string) => Number.parseInt(v, 10);
  program
    .command('live-window')
    .description(
      'Transition-matrix gate over a live window: did a transition improbable before the release become the most likely successor of its state (exit 0 passed, 2 fired, 3 too little data)',
    )
    .requiredOption(
      '--baseline <file>',
      'pre-release window JSON (LiveWindow), same capacity and grain',
    )
    .requiredOption('--live <file>', 'live window JSON (LiveWindow) recorded after the release')
    .option('--buckets <file>', 'declared bucket edges JSON (default: baseline quantiles)')
    .option('--percentile <p>', 'baseline bootstrap percentile to exceed (default 95)', Number)
    .option(
      '--min-transitions <n>',
      'live transitions a state needs before it can fire (default 20)',
      int,
    )
    .option(
      '--decompose-above <share>',
      'refine coarse states above this share of transitions (default 0.25)',
      Number,
    )
    .option('--bootstrap-samples <n>', 'bootstrap replicates per window (default 1000)', int)
    .option('--seed <n>', 'bootstrap seed (default 0)', int)
    .option('-o, --out <file>', 'also write the report here')
    .action(
      async (opts: {
        baseline: string;
        live: string;
        buckets?: string;
        percentile?: number;
        minTransitions?: number;
        decomposeAbove?: number;
        bootstrapSamples?: number;
        seed?: number;
        out?: string;
      }) => {
        exit(await liveWindowCommand(output(), opts));
      },
    );

  const gate = program
    .command('gate')
    .description('Policy gates that run outside a session: protected_paths and shadow_diff');
  gate
    .command('protected-paths')
    .description(
      "Hash the diff base...head and check it against the config's protected_paths policies (exit 1 when blocked); --json prints the manifest a variant registration sends",
    )
    .argument('[file]', 'path to agon.yaml', 'agon.yaml')
    .requiredOption(
      '--base <ref>',
      'base ref, e.g. origin/main (the diff starts at the merge base)',
    )
    .option('--head <ref>', 'head ref (default HEAD)')
    .option('--repo <dir>', 'git repository (default the current directory)')
    .action((file: string, opts: { base: string; head?: string; repo?: string }) => {
      exit(protectedPathsCommand(output(), { file, ...opts }));
    });
  gate
    .command('shadow-diff')
    .description(
      'Compare a control output with a variant output under a shadow_diff policy (exit 1 over budget)',
    )
    .argument('[file]', 'path to agon.yaml', 'agon.yaml')
    .requiredOption('--control <file>', 'control output (JSON)')
    .requiredOption('--variant <file>', 'variant output (JSON)')
    .option('--policy <id>', 'shadow_diff policy id (default: the only one)')
    .action(async (file: string, opts: { control: string; variant: string; policy?: string }) => {
      exit(await shadowDiffCommand(output(), { file, ...opts }));
    });

  const personas = program.command('personas').description('Browse the built-in persona library');
  personas
    .command('list', { isDefault: true })
    .description('List built-in personas')
    .action(() => exit(personasListCommand(output())));
  personas
    .command('show')
    .description('Show one built-in persona')
    .argument('<id>', 'persona id, with or without the builtin/ prefix')
    .action((id: string) => exit(personasShowCommand(output(), id)));

  program
    .command('schema')
    .description('Print the JSON Schema for agon.yaml')
    .action(() => exit(schemaCommand(output())));

  return program;
}
