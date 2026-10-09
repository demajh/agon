import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '@agon/spec';
import { beforeAll, describe, expect, it } from 'vitest';
import { createProgram } from '../program.js';
import { DIFF_ARGS, diffManifest } from './gate.js';

const BASE_CONFIG = `
version: 1
name: demo
target:
  kind: web
  variants:
    control: { url: http://a.test }
    treatment: { url: http://b.test }
population: { seed: 3, size: 2, personas: [{ use: builtin/smb-owner }] }
scenarios:
  - { id: s1, goal: Try it., success: judge }
`;

async function run(args: string[]): Promise<{ code: number; out: string }> {
  let code = -1;
  let out = '';
  const program = createProgram({ write: (t) => (out += t), exit: (c) => (code = c) });
  await program.parseAsync(['node', 'agon', ...args]);
  return { code, out };
}

function git(repo: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-C',
      repo,
      '-c',
      'user.name=agon',
      '-c',
      'user.email=agon@example.test',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { encoding: 'utf8' },
  );
}

describe('agon gate protected-paths', () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'agon-gate-repo-'));
    git(repo, 'init', '-q', '-b', 'main');
    mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'on: push\n');
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'src', 'old.ts'), 'export const old = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'checkout', '-q', '-b', 'variant');
    writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'on: push\njobs: {}\n');
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2;\n');
    renameSync(join(repo, 'src', 'old.ts'), join(repo, 'src', 'new.ts'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'variant');
  });

  function config(approvals: string[] = []): string {
    const dir = mkdtempSync(join(tmpdir(), 'agon-gate-config-'));
    const path = join(dir, 'agon.yaml');
    const approved = approvals.map(
      (h) => `\n      - { diffHash: ${h}, approvedBy: release-manager }`,
    );
    writeFileSync(
      path,
      `${BASE_CONFIG}policies:
  - kind: protected_paths
    id: ci
    paths: ['.github/workflows/**', '**/pnpm-lock.yaml']
    approvals: ${approved.length ? approved.join('') : '[]'}
`,
    );
    return path;
  }

  it('hashes the canonical diff of base...head and lists every touched path, renames as two', () => {
    const manifest = diffManifest(repo, 'main', 'variant');
    expect(manifest.paths.sort()).toEqual([
      '.github/workflows/ci.yml',
      'src/a.ts',
      'src/new.ts',
      'src/old.ts',
    ]);
    expect(manifest.hash).toBe(sha256Hex(git(repo, ...DIFF_ARGS, 'main...variant')));
    expect(diffManifest(repo, 'main', 'variant')).toEqual(manifest);
    expect(manifest).toMatchObject({ base: 'main', head: 'variant' });
  });

  it('blocks the diff until its exact hash is approved, and prints the manifest with --json', async () => {
    const blocked = await run([
      '--no-color',
      'gate',
      'protected-paths',
      config(),
      '--repo',
      repo,
      '--base',
      'main',
      '--head',
      'variant',
    ]);
    expect(blocked.code).toBe(1);
    expect(blocked.out).toMatch(/touches protected \.github\/workflows\/ci\.yml and no approval/);

    const json = await run([
      '--json',
      'gate',
      'protected-paths',
      config(),
      '--repo',
      repo,
      '--base',
      'main',
      '--head',
      'variant',
    ]);
    expect(json.code).toBe(1);
    const parsed = JSON.parse(json.out) as { ok: boolean; manifest: { hash: string } };
    expect(parsed.ok).toBe(false);

    const approved = await run([
      '--no-color',
      'gate',
      'protected-paths',
      config([parsed.manifest.hash]),
      '--repo',
      repo,
      '--base',
      'main',
      '--head',
      'variant',
    ]);
    expect(approved.code).toBe(0);
    expect(approved.out).toContain('approved by release-manager');

    const other = await run([
      '--no-color',
      'gate',
      'protected-paths',
      config(['0'.repeat(64)]),
      '--repo',
      repo,
      '--base',
      'main',
      '--head',
      'variant',
    ]);
    expect(other.code).toBe(1);
    const broken = await run([
      '--no-color',
      'gate',
      'protected-paths',
      config(),
      '--repo',
      repo,
      '--base',
      'no-such-ref',
    ]);
    expect(broken.code).toBe(1);
  });
});

describe('agon gate shadow-diff', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agon-shadow-'));
  const configPath = join(dir, 'agon.yaml');
  writeFileSync(
    configPath,
    `${BASE_CONFIG}analysis:
  materiality: { fields: [currency] }
policies:
  - kind: shadow_diff
    id: checkout
    contract:
      fields: { requestId: allow, 'items.*.description': semantic }
      default: allow
    budget: { disallowedDiffs: 1, expiresAt: '2099-01-01T00:00:00.000Z', owner: checkout-team }
`,
  );
  const write = (name: string, value: unknown) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  const control = write('control.json', {
    requestId: 'a',
    currency: 'USD',
    items: [{ description: 'Blue mug' }],
  });

  it('passes within budget and fails over it, counting unjudged semantic differences as material', async () => {
    const one = write('one.json', {
      requestId: 'b',
      currency: 'EUR',
      items: [{ description: 'Blue mug' }],
    });
    const within = await run([
      '--no-color',
      'gate',
      'shadow-diff',
      configPath,
      '--control',
      control,
      '--variant',
      one,
    ]);
    expect(within.code).toBe(0);
    expect(within.out).toContain('currency: "USD" -> "EUR"');
    expect(within.out).toContain('allowed to differ: requestId');

    const two = write('two.json', {
      requestId: 'b',
      currency: 'EUR',
      items: [{ description: 'Mug, blue' }],
    });
    const over = await run([
      '--json',
      'gate',
      'shadow-diff',
      configPath,
      '--control',
      control,
      '--variant',
      two,
    ]);
    expect(over.code).toBe(1);
    const report = (
      JSON.parse(over.out) as { report: { disallowed: { field: string; rule: string }[] } }
    ).report;
    expect(report.disallowed.map((d) => [d.field, d.rule])).toEqual([
      ['currency', 'disallow'],
      ['items.0.description', 'semantic'],
    ]);
    const unknown = await run([
      '--no-color',
      'gate',
      'shadow-diff',
      configPath,
      '--policy',
      'nope',
      '--control',
      control,
      '--variant',
      one,
    ]);
    expect(unknown.code).toBe(1);
    expect(unknown.out).toContain('no shadow_diff policy "nope"');
  });
});
