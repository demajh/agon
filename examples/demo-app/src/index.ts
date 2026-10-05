export { SESSION_COOKIE, VARIANT_COOKIE, createApp } from './app.js';
export {
  DEFAULT_POSTHOG_HOST,
  DEFAULT_POSTHOG_KEY,
  EVENTS,
  renderAnalyticsScript,
} from './analytics.js';
export type { EventName } from './analytics.js';
export { ONBOARDING_STEPS, REQUIRED_STEPS } from './onboarding.js';
export type { OnboardingStep } from './onboarding.js';
export { DEV_VERIFICATION_CODE, TAKEN_EMAIL } from './store.js';
export type { LoggedEvent, Project, User } from './store.js';
export { VARIANTS, isVariant } from './types.js';
export type { AppOptions, Variant } from './types.js';

export const PACKAGE_NAME = '@agon/demo-app';
