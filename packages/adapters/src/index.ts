export {
  createWebAdapter,
  DEFAULT_ACTION_TIMEOUT_MS,
  DEFAULT_NAVIGATION_TIMEOUT_MS,
  DEFAULT_SETTLE_TIMEOUT_MS,
} from './web/adapter.js';
export type { WebAdapter, WebAdapterOptions } from './web/adapter.js';
export { AGON_REF_ATTRIBUTE } from './web/session.js';
export {
  ANALYTICS_ROUTE_PATTERNS,
  RAW_ANALYTICS_EVENT,
  matchAnalyticsProvider,
  parseAnalyticsRequest,
  urlGlobToRegExp,
} from './web/analytics.js';
export type { AnalyticsRequest } from './web/analytics.js';
export {
  DEFAULT_MAX_INTERACTIVE,
  DEFAULT_MAX_TEXT_CHARS,
  buildObservation,
  normalizeText,
  observationHash,
} from './web/observe.js';
export type { BuildObservationOptions, RawPageState } from './web/observe.js';
export { DEVICE_DESCRIPTORS, deviceContextOptions } from './web/devices.js';
export { PRUNE_MIN_INTERACTIVE, PRUNE_MIN_TEXT_CHARS, pruneObservation } from './prune.js';
export type { PruneOptions } from './prune.js';
