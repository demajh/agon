import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SideEffectsPolicySchema } from '@agon/spec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SideEffectsGuard,
  listProcesses,
  sideEffectsEventProperties,
  snapshotFileTree,
} from './side-effects.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agon-side-effects-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'node_modules', 'x'), { recursive: true });
  await writeFile(join(dir, 'src', 'a.ts'), 'a');
  await writeFile(join(dir, 'README.md'), 'readme');
  await writeFile(join(dir, 'node_modules', 'x', 'index.js'), 'ignored');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('snapshotFileTree', () => {
  it('hashes every regular file by relative posix path, skipping ignored globs', async () => {
    const files = await snapshotFileTree(dir, ['**/node_modules/**']);
    expect(Object.keys(files)).toEqual(['README.md', 'src/a.ts']);
    expect(files['src/a.ts']).toMatch(/^[0-9a-f]{64}$/);
    await writeFile(join(dir, 'src', 'a.ts'), 'changed');
    expect((await snapshotFileTree(dir))['src/a.ts']).not.toBe(files['src/a.ts']);
    expect(await snapshotFileTree(join(dir, 'missing'))).toEqual({});
  });

  it('records a symbolic link by its target without following it', async () => {
    await symlink('/etc/hosts', join(dir, 'src', 'hosts'));
    const files = await snapshotFileTree(dir, ['**/node_modules/**']);
    expect(files['src/hosts']).toBe('link:/etc/hosts');
    expect(Object.keys(files)).toEqual(['README.md', 'src/a.ts', 'src/hosts']);
  });
});

describe('SideEffectsGuard', () => {
  const policy = SideEffectsPolicySchema.parse({
    kind: 'side_effects',
    id: 'workspace',
    scope: 'tool_call',
    observe: { files: { root: '.' }, processes: true },
    expected: ['out/**', 'proc:node *'],
  });

  it('snapshots, lets the call run, and counts the unexpected changes', async () => {
    let table: Record<string, string> = { '1': 'node server.js', '2': 'postgres' };
    const guard = new SideEffectsGuard(policy, { cwd: dir, processes: async () => table });
    const before = await guard.before();
    expect(before.processes).toEqual(table);
    // the "call"
    await mkdir(join(dir, 'out'), { recursive: true });
    await writeFile(join(dir, 'out', 'build.js'), 'ok');
    await writeFile(join(dir, '.env'), 'SECRET=1');
    await rm(join(dir, 'README.md'));
    table = { '2': 'postgres', '3': 'node worker.js', '4': 'curl evil' };
    const report = await guard.after(before);
    expect(report.expectedListSize).toBe(2);
    expect(report.expected.map((c) => c.path)).toEqual([
      'out/build.js',
      'proc:node server.js',
      'proc:node worker.js',
    ]);
    expect(report.unexpected).toEqual([
      { kind: 'file', path: '.env', change: 'added' },
      { kind: 'file', path: 'README.md', change: 'removed' },
      { kind: 'process', path: 'proc:curl evil', change: 'added' },
    ]);
    expect(sideEffectsEventProperties(report, { tool: 'write_file' })).toEqual({
      policy: 'workspace',
      scope: 'tool_call',
      observed: ['files', 'processes'],
      not_observable: ['network'],
      expected_list_size: 2,
      changes: 6,
      expected: 3,
      unexpected: 3,
      unexpected_changes: ['added:.env', 'removed:README.md', 'added:proc:curl evil'],
      tool: 'write_file',
    });
  });
});

describe('listProcesses', () => {
  it('lists this process and never the ps process that took the snapshot', async () => {
    const first = await listProcesses();
    const second = await listProcesses();
    expect(first[String(process.pid)]).toBeDefined();
    for (const table of [first, second]) {
      expect(Object.values(table).some((command) => command.startsWith('ps -eo'))).toBe(false);
    }
  });
});
