export const VARIANTS = ['control', 'treatment'] as const;
export type Variant = (typeof VARIANTS)[number];

export function isVariant(value: unknown): value is Variant {
  return typeof value === 'string' && (VARIANTS as readonly string[]).includes(value);
}

export interface AppOptions {
  /** Variant served by default. `?variant=control|treatment` on any URL overrides it per browser via a cookie. */
  variant: Variant;
  /** PostHog ingestion host the browser shim posts to. Default: https://us.i.posthog.com */
  posthogHost?: string;
  /** PostHog project token sent as `token` on every event. Any string works for the demo. */
  posthogKey?: string;
  /** Secret used to sign the session cookie. Random per process when omitted. */
  sessionSecret?: string;
  /** Clock used for timestamps; injectable for tests. */
  now?: () => Date;
}
