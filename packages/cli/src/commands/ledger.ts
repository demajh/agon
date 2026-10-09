import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DEFAULT_LEDGER_DIR, FileLedger } from '@agon/engine';
import { RunSchema, isAgonError, summarizeLedger, type LedgerEntry } from '@agon/spec';
import type { Output } from '../output.js';
import { resolveRunDir } from './trace.js';

export interface LedgerOptions {
  /** A run directory, an output directory (newest run), or a sample hash or prefix. */
  target: string;
  ledgerDir?: string | undefined;
}

/** Local-mode ledger location for runs under `outDir`: `<parent of outDir>/.agon/ledger`. */
export function ledgerDirFor(outDir: string): string {
  return join(dirname(resolve(outDir)), '.agon', 'ledger');
}

/** The ledger a run directory's run was written to, unless overridden. */
export function ledgerForRunDir(runDir: string, override?: string | undefined): FileLedger {
  return new FileLedger(override === undefined ? ledgerDirFor(dirname(runDir)) : resolve(override));
}

async function resolveTarget(
  options: LedgerOptions,
): Promise<{ ledger: FileLedger; sampleHash: string; runId?: string }> {
  const path = resolve(options.target);
  if (existsSync(path) && statSync(path).isDirectory()) {
    const runDir = resolveRunDir(path);
    const run = RunSchema.parse(JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')));
    if (run.sampleHash === undefined)
      throw new Error(`${runDir} has no sampleHash; it was recorded before the ledger existed`);
    return {
      ledger: ledgerForRunDir(runDir, options.ledgerDir),
      sampleHash: run.sampleHash,
      runId: run.id,
    };
  }
  const ledger = new FileLedger(resolve(options.ledgerDir ?? DEFAULT_LEDGER_DIR));
  const matches = await ledger.find(options.target);
  if (matches.length === 0)
    throw new Error(`no ledger for sample "${options.target}" under ${ledger.dir}`);
  if (matches.length > 1)
    throw new Error(
      `"${options.target}" matches ${matches.length} samples under ${ledger.dir}: ${matches.map((m) => m.slice(0, 12)).join(', ')}`,
    );
  return { ledger, sampleHash: matches[0] as string };
}

/** Prints the evaluation ledger of a run's sample: the trial count M and every entry. */
export async function ledgerCommand(out: Output, options: LedgerOptions): Promise<number> {
  try {
    const { ledger, sampleHash, runId } = await resolveTarget(options);
    const entries: LedgerEntry[] = await ledger.list(sampleHash);
    const summary = summarizeLedger(entries);
    if (out.options.json) {
      out.json({ ledgerDir: ledger.dir, runId, ...summary, sampleHash, entries });
      return 0;
    }
    out.heading(
      `sample ${sampleHash.slice(0, 12)} · M = ${summary.trials} distinct treatment variant(s) evaluated · ${entries.length} entries · ${ledger.path(sampleHash)}`,
    );
    if (entries.length === 0) {
      out.warn('no entries yet; the first run against this sample writes the first ones');
      return 0;
    }
    out.table(
      ['variant', 'key', 'role', 'runs', 'first', 'last event', 'discarded'],
      summary.variants.map((v) => [
        v.variant,
        v.variantKey.slice(v.variant.length + 1),
        v.role,
        v.runs.length,
        v.firstAt,
        v.lastEvent,
        v.discarded ? 'yes' : '',
      ]),
    );
    out.text();
    for (const e of entries) {
      out.text(
        `  ${e.at}  ${e.event.padEnd(9)} ${e.variantKey}${e.runId === runId ? ' (this run)' : ` ${e.runId}`}${e.note ? out.dim(` · ${e.note}`) : ''}`,
      );
    }
    out.text(
      out.dim(
        '  M counts every treatment variant ever started against this sample, discarded ones included; it resets only when the sample hash changes',
      ),
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
