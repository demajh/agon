import { Command } from 'commander';
import { personasListCommand, personasShowCommand } from './commands/personas.js';
import { planCommand } from './commands/plan.js';
import { runCommand } from './commands/run.js';
import { schemaCommand } from './commands/schema.js';
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
    .option('-o, --out <dir>', 'output directory (default ./agon-out or $AGON_OUT_DIR)')
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
          out?: string;
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
            out: opts.out,
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
    .command('trace')
    .description('Inspect a recorded run: list its sessions, or replay one step by step')
    .argument('<dir>', 'run directory (…/agon-out/<runId>) or an output directory (newest run)')
    .argument('[session]', 'session id, id suffix, or index')
    .option('--limit <n>', 'sessions to list', (v) => Number.parseInt(v, 10))
    .action((dir: string, session: string | undefined, opts: { limit?: number }) => {
      exit(traceCommand(output(), { dir, sessionId: session, limit: opts.limit }));
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
