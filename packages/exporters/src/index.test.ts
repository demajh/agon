import { ConfigError, ExportSchema } from '@agon/spec';
import type { ExportConfig } from '@agon/spec';
import { describe, expect, it } from 'vitest';
import { makeContext } from './__fixtures__/fixtures.js';
import {
  AmplitudeExporter,
  JsonlExporter,
  MultiExporter,
  PACKAGE_NAME,
  ParquetExporter,
  PostHogExporter,
  createExporter,
  createExporters,
} from './index.js';
import type { FetchLike } from './index.js';

const offlineFetch: FetchLike = async () => {
  throw new Error('network access is not allowed in tests');
};

describe('@agon/exporters', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@agon/exporters');
  });

  it('createExporter dispatches on config.type', async () => {
    const ctx = makeContext({ fetch: offlineFetch });
    const configs = [
      { type: 'jsonl', path: './agon-out' },
      { type: 'parquet', path: './agon-out' },
      { type: 'posthog', projectApiKey: 'phc_test', experimentKey: 'onboarding-redesign' },
      { type: 'amplitude', apiKey: 'amp_test' },
    ].map((input) => ExportSchema.parse(input));

    const [jsonl, parquet, posthog, amplitude] = configs.map((config) =>
      createExporter(config, ctx),
    );
    expect(jsonl).toBeInstanceOf(JsonlExporter);
    expect(parquet).toBeInstanceOf(ParquetExporter);
    expect(posthog).toBeInstanceOf(PostHogExporter);
    expect(amplitude).toBeInstanceOf(AmplitudeExporter);
    expect((posthog as PostHogExporter).experimentKey).toBe('onboarding-redesign');
    for (const exporter of [jsonl, parquet, posthog, amplitude]) await exporter?.close();
  });

  it('createExporters wraps every sink in a MultiExporter', async () => {
    const configs = [
      ExportSchema.parse({ type: 'jsonl', path: './agon-out' }),
      ExportSchema.parse({ type: 'amplitude', apiKey: 'amp_test' }),
    ];
    const multi = createExporters(configs, makeContext({ fetch: offlineFetch }));
    expect(multi).toBeInstanceOf(MultiExporter);
    expect(multi.exporters.map((e) => e.name)).toEqual(['jsonl', 'amplitude']);
    await multi.close();
  });

  it('rejects an unknown export type with ConfigError', () => {
    const bogus = { type: 'datadog', apiKey: 'x' } as unknown as ExportConfig;
    expect(() => createExporter(bogus, makeContext())).toThrow(ConfigError);
  });
});
