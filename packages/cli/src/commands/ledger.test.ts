import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAdapter, FakeLlm, happyUser, ledgerlySite } from '@agon/engine/fakes';
import { describe, expect, it } from 'vitest';
import { Output } from '../output.js';
import { ledgerCommand, ledgerDirFor } from './ledger.js';
import { runCommand } from './run.js';

const CONFIG = `
version: 1
name: ledgerly-ledger-test
target:
  kind: web
  variants:
    control: { url: http://control.test }
    treatment: { url: http://treatment.test }
  capture: { analytics: [posthog], screenshots: never }
personas:
  - id: eager
    name: Eager user
    summary: You want this to work.
    traits: { role: owner, patience: 0.9, attention: 0.9 }
population: { seed: 1, size: 2, personas: [{ use: eager }], traitJitter: 0 }
scenarios:
  - { id: first-project, goal: Sign up and create a project., success: event:project_created, maxSteps: 12 }
defaults: { model: fake/model-1, temperature: 0 }
`;

function capture(json = false): { out: Output; text: () => string } {
  let text = '';
  const out = new Output({ json, color: false }, (t) => (text += t));
  return { out, text: () => text };
}

describe('agon ledger', () => {
  it('records every run against the sample next to the output directory and prints M', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agon-ledger-cli-'));
    const file = join(dir, 'agon.yaml');
    writeFileSync(file, CONFIG);
    const outDir = join(dir, 'out');
    const deps = () => ({ llm: new FakeLlm(happyUser), adapter: new FakeAdapter(ledgerlySite) });

    const first = capture(true);
    expect(await runCommand(first.out, { file, out: outDir, llmMode: 'off' }, deps())).toBe(0);
    const json = JSON.parse(first.text()) as {
      runDir: string;
      sampleHash: string;
      trials: number;
      ledgerDir: string;
    };
    expect(json.sampleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(json.trials).toBe(1);
    expect(json.ledgerDir).toBe(ledgerDirFor(outDir));
    expect(json.ledgerDir).toBe(join(dir, '.agon', 'ledger'));
    expect(existsSync(join(json.ledgerDir, `${json.sampleHash}.jsonl`))).toBe(true);
    const recorded = JSON.parse(readFileSync(join(json.runDir, 'run.json'), 'utf8')) as {
      sampleHash: string;
    };
    expect(recorded.sampleHash).toBe(json.sampleHash);

    // A second variant against the same sample: M = 2 and the same hash.
    writeFileSync(
      file,
      CONFIG.replace(
        'treatment: { url: http://treatment.test }',
        'treatment: { url: http://treatment.test }\n    shiny: { url: http://shiny.test }',
      ),
    );
    const second = capture(true);
    expect(
      await runCommand(
        second.out,
        { file, out: outDir, llmMode: 'off', variants: ['control', 'shiny'] },
        deps(),
      ),
    ).toBe(0);
    const again = JSON.parse(second.text()) as { sampleHash: string; trials: number };
    expect(again.sampleHash).toBe(json.sampleHash);
    expect(again.trials).toBe(2);

    const byRun = capture();
    expect(await ledgerCommand(byRun.out, { target: json.runDir })).toBe(0);
    expect(byRun.text()).toContain(
      `sample ${json.sampleHash.slice(0, 12)} · M = 2 distinct treatment variant(s) evaluated · 8 entries`,
    );
    expect(byRun.text()).toMatch(/treatment\s+[0-9a-f]{12}\s+treatment\s+1\s+\S+\s+completed/);
    expect(byRun.text()).toMatch(/shiny\s+[0-9a-f]{12}\s+treatment\s+1\s+\S+\s+completed/);
    expect(byRun.text()).toContain('(this run)');

    const byHash = capture(true);
    expect(
      await ledgerCommand(byHash.out, {
        target: json.sampleHash.slice(0, 8),
        ledgerDir: json.ledgerDir,
      }),
    ).toBe(0);
    const summary = JSON.parse(byHash.text()) as {
      sampleHash: string;
      trials: number;
      entries: { event: string }[];
      variants: { variant: string; discarded: boolean }[];
    };
    expect(summary.sampleHash).toBe(json.sampleHash);
    expect(summary.trials).toBe(2);
    expect(summary.entries.map((e) => e.event)).toEqual([
      'started',
      'started',
      'completed',
      'completed',
      'started',
      'started',
      'completed',
      'completed',
    ]);
    expect(summary.variants.map((v) => v.variant)).toEqual(['control', 'treatment', 'shiny']);

    const missing = capture();
    expect(await ledgerCommand(missing.out, { target: 'ffff', ledgerDir: json.ledgerDir })).toBe(1);
    expect(missing.text()).toMatch(/no ledger for sample "ffff"/);
    expect(readdirSync(outDir).filter((d) => d.startsWith('run_'))).toHaveLength(2);
  });
});
