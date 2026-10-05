import { Command } from 'commander';
import { personasListCommand, personasShowCommand } from './commands/personas.js';
import { planCommand } from './commands/plan.js';
import { schemaCommand } from './commands/schema.js';
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
