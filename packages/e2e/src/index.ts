/**
 * Helpers behind the end-to-end suite: the demo app and an analytics sink started in-process, and
 * the scripted Ledgerly user that drives them through `FakeLlm`.
 */
export {
  demoAppEvents,
  startAnalyticsSink,
  startDemoApp,
  type AnalyticsSink,
  type DemoAppOptions,
  type RunningServer,
} from './demo.js';
export {
  E2E_COMPANY,
  E2E_PASSWORD,
  E2E_PROJECT_NAME,
  firstRealOption,
  ledgerlyUser,
  readControls,
  selectOptions,
  uniqueEmail,
  type Control,
} from './ledgerly-user.js';
