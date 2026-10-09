import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  LedgerEntrySchema,
  ValidationError,
  type EvaluationLedger,
  type LedgerEntry,
} from '@agon/spec';

/** Local-mode ledger location, next to `.agon/llm-cache`, relative to the working directory. */
export const DEFAULT_LEDGER_DIR = '.agon/ledger';

const SAFE_HASH = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The local evaluation ledger: one JSONL file per sample hash under `dir`, appended to and never
 * rewritten. Every line is a `LedgerEntry`.
 */
export class FileLedger implements EvaluationLedger {
  constructor(readonly dir: string) {}

  path(sampleHash: string): string {
    if (!SAFE_HASH.test(sampleHash))
      throw new ValidationError(`invalid sample hash: ${sampleHash}`);
    return join(this.dir, `${sampleHash}.jsonl`);
  }

  async append(entry: LedgerEntry): Promise<void> {
    const parsed = LedgerEntrySchema.parse(entry);
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.path(parsed.sampleHash), `${JSON.stringify(parsed)}\n`, 'utf8');
  }

  async list(sampleHash: string): Promise<LedgerEntry[]> {
    let text: string;
    try {
      text = await readFile(this.path(sampleHash), 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return [];
      throw error;
    }
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line, i) => {
        const parsed = LedgerEntrySchema.safeParse(JSON.parse(line));
        if (!parsed.success)
          throw new ValidationError(`${this.path(sampleHash)}:${i + 1}: not a ledger entry`);
        return parsed.data;
      });
  }

  /** Sample hashes recorded under `dir` that start with `prefix` (every hash when empty). */
  async find(prefix = ''): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return [];
      throw error;
    }
    return names
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => n.slice(0, -'.jsonl'.length))
      .filter((h) => h.startsWith(prefix))
      .sort();
  }
}
