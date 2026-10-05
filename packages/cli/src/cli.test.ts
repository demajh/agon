import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProgram } from './program.js';

const VALID = `
version: 1
name: demo
target:
  kind: web
  variants:
    control: { url: http://a.test }
    treatment: { url: http://b.test }
population:
  seed: 3
  size: 6
  personas:
    - { use: builtin/smb-owner, weight: 2 }
    - { use: builtin/skeptical-cfo, weight: 1 }
scenarios:
  - { id: s1, goal: Try it., success: judge, budgetUsd: 0.25 }
metrics:
  - { id: act, type: conversion, event: project_created, primary: true }
`;

async function run(args: string[]): Promise<{ code: number; out: string }> {
  let code = -1;
  let out = '';
  const program = createProgram({ write: (t) => (out += t), exit: (c) => (code = c) });
  await program.parseAsync(['node', 'agon', ...args]);
  return { code, out };
}

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agon-cli-'));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe('agon validate', () => {
  it('accepts a valid file and summarizes it', async () => {
    const { code, out } = await run(['--no-color', 'validate', tmpFile('agon.yaml', VALID)]);
    expect(code).toBe(0);
    expect(out).toContain('is valid');
    expect(out).toContain('2 variant(s) [control, treatment], control = control');
    expect(out).toContain('metrics: scenario_success, act*');
  });

  it('reports schema errors with a non-zero exit, in text and json', async () => {
    const path = tmpFile('agon.yaml', VALID.replace('size: 6', 'size: -1'));
    const text = await run(['--no-color', 'validate', path]);
    expect(text.code).toBe(1);
    expect(text.out).toContain('✗');
    expect(text.out).toMatch(/size/);
    const json = await run(['--json', 'validate', path]);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out)).toMatchObject({ ok: false });
  });

  it('reports a missing file', async () => {
    const { code, out } = await run(['--no-color', 'validate', '/nonexistent/agon.yaml']);
    expect(code).toBe(1);
    expect(out).toMatch(/ENOENT|no such file/);
  });
});

describe('agon plan', () => {
  it('prints a balanced plan and honours overrides', async () => {
    const path = tmpFile('agon.yaml', VALID);
    const { code, out } = await run([
      '--json',
      'plan',
      path,
      '--size',
      '10',
      '--seed',
      '1',
      '--variant',
      'treatment',
    ]);
    expect(code).toBe(0);
    const plan = JSON.parse(out) as {
      size: number;
      byVariant: Record<string, number>;
      byPersona: Record<string, number>;
      sessions: unknown[];
      worstCaseUsd: number;
    };
    expect(plan.size).toBe(10);
    expect(plan.byVariant).toEqual({ treatment: 10 });
    expect(Object.keys(plan.byPersona).sort()).toEqual(expect.arrayContaining(['smb-owner']));
    expect(plan.sessions).toHaveLength(10);
    expect(plan.worstCaseUsd).toBeCloseTo(2.5);
    const text = await run(['--no-color', 'plan', path]);
    expect(text.code).toBe(0);
    expect(text.out).toContain('demo: 6 sessions (seed 3)');
    expect(text.out).toContain('variants: ');
  });

  it('rejects unknown variants', async () => {
    const { code, out } = await run([
      '--no-color',
      'plan',
      tmpFile('agon.yaml', VALID),
      '--variant',
      'nope',
    ]);
    expect(code).toBe(1);
    expect(out).toMatch(/unknown variant "nope"/);
  });
});

describe('agon personas', () => {
  it('lists and shows built-in personas', async () => {
    const list = await run(['--no-color', 'personas', 'list']);
    expect(list.code).toBe(0);
    expect(list.out).toContain('builtin/smb-owner');
    const show = await run(['--no-color', 'personas', 'show', 'builtin/skeptical-cfo']);
    expect(show.code).toBe(0);
    expect(show.out).toContain('Skeptical CFO');
    expect(show.out).toContain('priceSensitivity');
    const missing = await run(['--no-color', 'personas', 'show', 'nobody']);
    expect(missing.code).toBe(1);
    expect(missing.out).toMatch(/no built-in persona "nobody"/);
  });
});

describe('agon schema', () => {
  it('prints the agon.yaml JSON schema', async () => {
    const { code, out } = await run(['schema']);
    expect(code).toBe(0);
    const schema = JSON.parse(out) as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toContain('population');
  });
});
