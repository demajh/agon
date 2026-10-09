import type { ExportConfig } from '@agon/spec';
import { ConfigError } from '@agon/spec';
import { AmplitudeExporter } from './amplitude.js';
import type { Exporter, ExporterContext } from './exporter.js';
import { JsonlExporter } from './jsonl.js';
import { MultiExporter } from './multi.js';
import { ParquetExporter } from './parquet.js';
import { PostHogExporter } from './posthog.js';

export const PACKAGE_NAME = '@agon/exporters';

export type {
  AmplitudeExportConfig,
  ExportFailure,
  Exporter,
  ExporterContext,
  ExporterLogger,
  FetchInit,
  FetchLike,
  FetchResponseLike,
  JsonlExportConfig,
  ParquetExportConfig,
  PostHogExportConfig,
} from './exporter.js';
export {
  ExportError,
  FailureCollector,
  SinkError,
  assertAllSimulated,
  defaultFetch,
  errorMessage,
  readMarkers,
} from './exporter.js';
export type { EventRow, ExposureRow, MetricValueRow, SessionRow } from './rows.js';
export { eventRow, exposureRow, metricValueRows, sessionRow } from './rows.js';
export type { JsonlManifest, JsonlManifestFile } from './jsonl.js';
export { JSONL_FILES, JsonlExporter } from './jsonl.js';
export type { ParquetColumn, ParquetColumnType, ParquetRowCounts } from './parquet.js';
export {
  EVENT_COLUMNS,
  EXPOSURE_COLUMNS,
  METRIC_VALUE_COLUMNS,
  PARQUET_FILES,
  ParquetExporter,
  SESSION_COLUMNS,
  parquetTable,
  toColumnData,
} from './parquet.js';
export type { PostHogExporterOptions } from './posthog.js';
export { POSTHOG_DEFAULTS, PostHogExporter, personaProperties } from './posthog.js';
export type { AmplitudeEvent, AmplitudeExporterOptions, AmplitudeUploadBody } from './amplitude.js';
export {
  AMPLITUDE_DEFAULTS,
  AmplitudeExporter,
  identifyEvent,
  isRetryableStatus,
  toAmplitudeEvent,
} from './amplitude.js';
export { MultiExporter } from './multi.js';
export type { IngestOutcome, ReplayOutcome, RowGateOptions, ServeOutcome } from './gate.js';
export { RowGate, loadGateSnapshot, saveGateSnapshot } from './gate.js';

/** Builds the sink for one `export:` entry of `agon.yaml`. */
export function createExporter(config: ExportConfig, ctx: ExporterContext): Exporter {
  switch (config.type) {
    case 'jsonl':
      return new JsonlExporter(config, ctx);
    case 'parquet':
      return new ParquetExporter(config, ctx);
    case 'posthog':
      return new PostHogExporter(config, ctx);
    case 'amplitude':
      return new AmplitudeExporter(config, ctx);
    default: {
      const unknown: never = config;
      throw new ConfigError(
        `unknown export type: ${String((unknown as { type?: unknown }).type)}`,
        unknown,
      );
    }
  }
}

/** Builds every configured sink behind one `MultiExporter` that isolates failures per sink. */
export function createExporters(
  configs: readonly ExportConfig[],
  ctx: ExporterContext,
): MultiExporter {
  return new MultiExporter(
    configs.map((config) => createExporter(config, ctx)),
    ctx.logger,
  );
}
