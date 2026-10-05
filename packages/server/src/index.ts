export const PACKAGE_NAME = '@agon/server';

export { createServer, resolveConfig } from './server.js';
export type { AgonServer, CreateServerOptions } from './server.js';
export { createApp } from './app.js';
export type { AgonApp } from './app.js';
export {
  DEFAULT_DATA_DIR,
  DEFAULT_PORT,
  SERVER_ROLES,
  parseBootstrapKeys,
  readServerConfig,
  roleIncludesApi,
  roleIncludesWorker,
} from './config.js';
export type { BootstrapKey, ServerConfig, ServerRole } from './config.js';
export type { AppContext } from './context.js';
export { createAuthMiddleware, isAllowed, matchBootstrapKey, resolvePrincipal } from './auth.js';
export type { AuthEnv, Principal } from './auth.js';
export { createErrorHandler, notFoundHandler, toAgonError, validationError } from './errors.js';
export type { ErrorBody } from './errors.js';
export { buildOpenApiDocument, packageVersion } from './openapi.js';
export * from './schemas.js';
export { RUN_QUEUE, createRunQueue } from './queue.js';
export type { RunJobData, RunJobHandler, RunQueue } from './queue.js';
export { createWebhookEmitter } from './webhooks.js';
export type { FetchLike, WebhookEmitter } from './webhooks.js';
export { createControlSender, ControlDeliveryError } from './squads/control.js';
export type { ControlSender } from './squads/control.js';
export { executeDecision, assertActionAllowed, ACTION_STATUS } from './squads/executor.js';
export type { SquadAction } from './squads/executor.js';
export {
  DEFAULT_ALLOCATION_FLOOR,
  actOnSquad,
  approveDecision,
  decide,
  reallocate,
  rejectDecision,
} from './squads/actions.js';
export type {
  Approval,
  DecideInput,
  ReallocateInput,
  ReallocateOutcome,
  SquadActionInput,
} from './squads/actions.js';
export { bestComparison, creditedSquads, isLoss, isWin } from './squads/credit.js';
export { rollingPBest, squadResultHistory } from './squads/history.js';
export {
  COMPARISON_OPS,
  POLICY_VARIABLES,
  evaluateCondition,
  evaluatePolicies,
  guardrailSkip,
  parseCondition,
  referencedVariables,
  resolveVariables,
  validatePolicies,
  variableKey,
} from './policies.js';
export type {
  ComparisonOp,
  Expr,
  Literal,
  PolicyOutcome,
  PolicyRunInput,
  PolicySkipReason,
  PolicyTrigger,
  PolicyVariableName,
  VariableRef,
  VariableScope,
  VariableValue,
} from './policies.js';
export { rankSquads } from './routes/squads.js';
export { mergeVariant } from './routes/variants.js';
export { snapshotConfig } from './routes/runs.js';
export { builtinPersonas } from './routes/personas.js';
export { defaultRunDependencies, defaultStatsClient } from './worker/deps.js';
export type {
  AllocateOptions,
  RunDependencies,
  RunDependenciesFactory,
  RunDependenciesInput,
  StatsClient,
} from './worker/deps.js';
export {
  composeRecorders,
  createExporterRecorder,
  createProgressRecorder,
  createScreenshotRecorder,
  runIdOf,
  screenshotPath,
} from './worker/recorders.js';
export {
  CANCEL_POLL_MS,
  dataPaths,
  listAllSessions,
  processRun,
  registerRunWorker,
  resolveExportPaths,
  writeSessionsJsonl,
} from './worker/run-worker.js';
export { updateSquadScores } from './worker/scoring.js';
export type { ScoreUpdate } from './worker/scoring.js';
