import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  agonConfigJsonSchema,
  controlVariant,
  parseAgonConfig,
  substituteEnv,
} from './index.js';

const example = readFileSync(new URL('./__fixtures__/agon.example.yaml', import.meta.url), 'utf8');
const env = { PREVIEW_URL: 'https://pr-123.example.app', POSTHOG_SIM_KEY: 'phc_test' };

describe('parseAgonConfig', () => {
  it('parses the example and applies defaults at every level', () => {
    const cfg = parseAgonConfig(example, { env });
    expect(cfg.name).toBe('onboarding-redesign');
    expect(cfg.target.kind).toBe('web');
    expect(cfg.target.variants['treatment']?.url).toBe('https://pr-123.example.app');
    expect(cfg.target.variants['treatment']?.squad).toBe('squad-blue');
    expect(cfg.target.capture.analytics).toEqual(['posthog']);
    expect(cfg.target.capture.networkErrors).toBe(true);
    expect(cfg.target.viewport).toEqual({ width: 1280, height: 800 });
    expect(cfg.analysis.method).toBe('bayesian');
    expect(cfg.analysis.minSessionsPerVariant).toBe(100);
    expect(cfg.analysis.decision).toEqual({ shipIf: 0.95, killIf: 0.05 });
    expect(cfg.scenarios[0]?.maxSteps).toBe(40);
    expect(cfg.scenarios[0]?.startPath).toBe('/');
    expect(cfg.scenarios[0]?.success).toEqual({ type: 'event', name: 'project_created' });
    expect(cfg.defaults.model).toBe('anthropic/claude-sonnet-5-5');
    expect(cfg.defaults.maxConcurrency).toBe(4);
    expect(cfg.personas[0]?.traits.domainFamiliarity).toBe(0.5);
    expect(cfg.personas[0]?.device).toBe('desktop');
    expect(cfg.export[0]).toMatchObject({ type: 'posthog', projectApiKey: 'phc_test' });
    expect(cfg.policies[0]).toMatchObject({ then: 'pause', cooldown: '24h', floor: 0.1 });
  });

  it('reports every missing environment variable at once', () => {
    expect(() => parseAgonConfig(example, { env: {} })).toThrowError(
      /missing environment variables: POSTHOG_SIM_KEY, PREVIEW_URL/,
    );
  });

  it('supports ${VAR:-default} and leaves non-strings alone', () => {
    expect(substituteEnv({ a: '${X:-fallback}', b: ['${Y}', 3, true] }, { Y: 'y' })).toEqual({
      a: 'fallback',
      b: ['y', 3, true],
    });
  });

  it('rejects a control that is not a variant', () => {
    const text = example.replace('method: bayesian', 'method: bayesian\n  control: nope');
    expect(() => parseAgonConfig(text, { env })).toThrow(ConfigError);
    expect(() => parseAgonConfig(text, { env })).toThrow(/control "nope" is not one of the variants/);
  });

  it('rejects duplicate scenario ids', () => {
    const text = example.replace(
      'scenarios:\n',
      'scenarios:\n  - { id: first-project, goal: dup, success: judge }\n',
    );
    expect(() => parseAgonConfig(text, { env })).toThrow(/duplicate scenario id "first-project"/);
  });

  it('rejects web variants without a url', () => {
    const text = example.replace('      url: https://app.example.com\n', '      description: no url\n');
    expect(() => parseAgonConfig(text, { env })).toThrow(/web variants need a url/);
  });

  it('rejects more than one primary metric', () => {
    const text = example.replace('to: project_created }', 'to: project_created, primary: true }');
    expect(() => parseAgonConfig(text, { env })).toThrow(/at most one metric may be primary/);
  });

  it('rejects inline persona references that do not exist', () => {
    const text = example.replace('use: skeptical-cfo', 'use: missing-person');
    expect(() => parseAgonConfig(text, { env })).toThrow(/"missing-person" is neither builtin/);
  });

  it('rejects invalid success shorthand', () => {
    const text = example.replace('success: event:project_created', 'success: whenever');
    expect(() => parseAgonConfig(text, { env })).toThrow(ConfigError);
  });

  it('rejects malformed YAML and non-mapping documents', () => {
    expect(() => parseAgonConfig('version: [1', { env })).toThrow(/invalid YAML/);
    expect(() => parseAgonConfig('- just a list', { env })).toThrow(/must be a mapping/);
  });
});

describe('controlVariant', () => {
  it('prefers analysis.control, then "control", then the first variant', () => {
    const cfg = parseAgonConfig(example, { env });
    expect(controlVariant(cfg)).toBe('control');
    expect(controlVariant({ ...cfg, analysis: { ...cfg.analysis, control: 'treatment' } })).toBe('treatment');
    const renamed = {
      ...cfg,
      target: {
        ...cfg.target,
        variants: { a: cfg.target.variants['control']!, b: cfg.target.variants['treatment']! },
      },
    };
    expect(controlVariant(renamed)).toBe('a');
  });
});

describe('agonConfigJsonSchema', () => {
  it('produces a draft 2020-12 schema describing the input document', () => {
    const schema = agonConfigJsonSchema();
    expect(String(schema['$schema'])).toContain('2020-12');
    const properties = schema['properties'] as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining(['version', 'name', 'target', 'population', 'scenarios', 'metrics', 'analysis', 'export']),
    );
    expect(JSON.stringify(schema)).toContain('event:<name>');
  });
});
