import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Output, compareCommand, runCommand, traceCommand } from '@agon/cli';
import { FakeLlm, parsePrompt, type UserPolicy } from '@agon/engine/fakes';
import { ResultSchema, SessionSchema } from '@agon/spec';
import { describe, expect, it } from 'vitest';

/**
 * The whole agent-usability path with a real MCP server: `agon run` → engine agent prompts →
 * the stdio MCP adapter → the fixture ledger server → JSONL record → `agon compare`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const tsx = resolve(here, '../node_modules/.bin/tsx');
const fixture = resolve(repoRoot, 'packages/adapters/src/mcp/__fixtures__/ledger-stdio.ts');

/** Finds a tool by name among the refs the prompt lists and calls it; stops when the ledger confirms. */
const bookkeepingAgent: UserPolicy = (p) => {
  const base = {
    perception: 'A ledger server with a few tools.',
    thinking: 'Create the project the user asked for.',
    feeling: 'confident' as const,
    progress: 'progress' as const,
  };
  if (/created project "Books"/.test(p.text)) {
    return {
      ...base,
      perception: 'The server confirmed the project.',
      action: { type: 'done', reason: 'Project Books exists.' },
    };
  }
  const create = [...p.refs.entries()].find(
    ([, r]) => r.role === 'tool' && r.name === 'create_project',
  );
  if (create)
    return {
      ...base,
      action: { type: 'tool_call', ref: create[0], arguments: { name: 'Books', currency: 'EUR' } },
    };
  return {
    ...base,
    feeling: 'confused',
    progress: 'none',
    action: { type: 'give_up', reason: 'No create_project tool in the catalog.' },
  };
};

function capture(json = false): { out: Output; text: () => string } {
  let text = '';
  const out = new Output({ json, color: false }, (t) => (text += t));
  return { out, text: () => text };
}

describe('agon run against a real MCP server over stdio', () => {
  it('drives an agent persona through tool calls, records the run, and analyzes it', async () => {
    expect(existsSync(tsx), `tsx at ${tsx}`).toBe(true);
    expect(existsSync(fixture), fixture).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'agon-mcp-e2e-'));
    const file = join(dir, 'agon.yaml');
    writeFileSync(
      file,
      `version: 1
name: ledger-mcp
target:
  kind: mcp
  variants:
    control:
      command: "${tsx} ${fixture}"
population:
  seed: 3
  size: 2
  personas:
    - { use: builtin/terminal-coding-agent, weight: 1 }
    - { use: builtin/minimal-loop-agent, weight: 1 }
  traitJitter: 0
scenarios:
  - id: create-books
    goal: Create a project called Books billed in euros.
    success: text:created project "Books"
    maxSteps: 6
    budgetUsd: 1
metrics:
  - { id: tool_calls, type: count, event: $agon_tool_call }
  - { id: tool_errors, type: count, event: $agon_tool_error }
analysis: { minSessionsPerVariant: 1 }
defaults: { model: fake/model-1, temperature: 0 }
`,
    );
    const outDir = join(dir, 'out');
    const run = capture();
    const code = await runCommand(
      run.out,
      { file, out: outDir, llmMode: 'off' },
      { llm: new FakeLlm(bookkeepingAgent) },
    );
    expect(code, run.text()).toBe(0);
    expect(run.text()).toContain('completed: 2/2 sessions');

    const list = capture(true);
    expect(traceCommand(list.out, { dir: outDir })).toBe(0);
    const listed = JSON.parse(list.text()) as { runDir: string; sessions: unknown[] };
    const sessions = listed.sessions.map((s) => SessionSchema.parse(s));
    expect(sessions).toHaveLength(2);
    for (const s of sessions) {
      expect(s.outcome).toBe('success');
      expect(s.persona.harness).toBeDefined();
      expect(s.metrics).toMatchObject({ scenario_success: 1, tool_calls: 1, tool_errors: 0 });
    }

    const steps = readFileSync(join(listed.runDir, 'steps.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(
        (l) =>
          JSON.parse(l) as {
            observation: {
              url: string;
              text: string;
              interactive: { role: string; name: string }[];
            };
            decision: { action: { type: string } };
          },
      );
    expect(steps.every((s) => s.decision.action.type === 'tool_call')).toBe(true);
    expect(steps[0]?.observation.url).toBe('mcp://ledger');
    expect(steps[0]?.observation.text).toContain('create_project');
    expect(
      steps[0]?.observation.interactive.some(
        (e) => e.role === 'tool' && e.name === 'delete_project',
      ),
    ).toBe(true);

    const events = readFileSync(join(listed.runDir, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { event: string; properties: Record<string, unknown> });
    const calls = events.filter((e) => e.event === '$agon_tool_call');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.properties).toMatchObject({
      tool: 'create_project',
      is_error: false,
      agon_simulated: true,
    });

    const parsed = parsePrompt('URL: mcp://ledger\n[t1] tool "create_project"');
    expect(parsed.refs.get('t1')?.name).toBe('create_project');

    if (process.env['AGON_SKIP_STATS_TESTS'] !== '1') {
      const cmp = capture(true);
      expect(await compareCommand(cmp.out, { dir: listed.runDir })).toBe(0);
      const result = ResultSchema.parse((JSON.parse(cmp.text()) as { result: unknown }).result);
      expect(result.metrics.map((m) => m.metricId)).toEqual([
        'scenario_success',
        'tool_calls',
        'tool_errors',
      ]);
      expect(result.calibration.note.length).toBeGreaterThan(10);
    }
  }, 180_000);
});
