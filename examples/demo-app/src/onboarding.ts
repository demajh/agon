import type { Store, User } from './store.js';
import type { Variant } from './types.js';

export const ONBOARDING_STEPS = ['verify', 'profile', 'connect-bank', 'invite', 'project'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export function isOnboardingStep(value: unknown): value is OnboardingStep {
  return typeof value === 'string' && (ONBOARDING_STEPS as readonly string[]).includes(value);
}

/**
 * Steps a user must finish before reaching the dashboard. This is the experiment:
 * control walks every step in order, treatment only asks for the project.
 */
export const REQUIRED_STEPS: Record<Variant, readonly OnboardingStep[]> = {
  control: ONBOARDING_STEPS,
  treatment: ['project'],
};

export const STEP_LABELS: Record<OnboardingStep, string> = {
  verify: 'Verify email',
  profile: 'Your team',
  'connect-bank': 'Connect a bank',
  invite: 'Invite teammates',
  project: 'First project',
};

export function isStepComplete(step: OnboardingStep, user: User, store: Store): boolean {
  switch (step) {
    case 'verify':
      return user.verified;
    case 'profile':
      return user.profile !== undefined;
    case 'connect-bank':
      return user.bank !== undefined || user.bankSkipped;
    case 'invite':
      return user.inviteStepDone;
    case 'project':
      return store.projectsForUser(user.id).length > 0;
  }
}

/** The first required step the user has not finished, or undefined once onboarding is complete. */
export function nextRequiredStep(
  user: User,
  variant: Variant,
  store: Store,
): OnboardingStep | undefined {
  return REQUIRED_STEPS[variant].find((step) => !isStepComplete(step, user, store));
}

/** Where a user lands after finishing any step. */
export function afterStepUrl(user: User, variant: Variant, store: Store): string {
  const next = nextRequiredStep(user, variant, store);
  return next ? `/onboarding/${next}` : '/app';
}

/** Steps that can also be done later, from the dashboard. */
export type SetupStep = Exclude<OnboardingStep, 'project'>;

/** Optional setup the dashboard still suggests. Treatment relies on these; control rarely shows any. */
export function dashboardSuggestions(user: User): SetupStep[] {
  const suggestions: SetupStep[] = [];
  if (!user.verified) suggestions.push('verify');
  if (!user.profile) suggestions.push('profile');
  if (!user.bank) suggestions.push('connect-bank');
  if (user.invites.length === 0) suggestions.push('invite');
  return suggestions;
}
