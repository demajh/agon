import { z } from 'zod';
import { SlugSchema } from './common.js';

export const TargetKindSchema = z.enum(['web', 'http', 'cli', 'mcp']);
export type TargetKind = z.infer<typeof TargetKindSchema>;

export const VariantSpecSchema = z.object({
  url: z.url().optional().describe('Entry URL (web/http/mcp targets)'),
  image: z.string().optional().describe('Container image to run for this variant (later phase)'),
  command: z.string().optional().describe('Command to run (cli targets)'),
  env: z.record(z.string(), z.string()).default({}),
  headers: z.record(z.string(), z.string()).default({}),
  description: z.string().optional(),
  squad: SlugSchema.optional().describe('Squad credited with this variant'),
  gitRef: z.string().optional(),
});
export type VariantSpec = z.infer<typeof VariantSpecSchema>;

export const AnalyticsProviderSchema = z.enum(['posthog', 'segment', 'amplitude', 'ga']);
export type AnalyticsProvider = z.infer<typeof AnalyticsProviderSchema>;

export const CaptureSchema = z.object({
  analytics: z
    .array(AnalyticsProviderSchema)
    .default([])
    .describe("Intercept the app's own analytics calls and attribute them to the simulated user"),
  forwardAnalytics: z
    .boolean()
    .default(false)
    .describe('Let intercepted analytics calls reach their real destination (default: block them)'),
  networkErrors: z.boolean().default(true),
  consoleErrors: z.boolean().default(true),
  screenshots: z.enum(['never', 'on_decision', 'every_step']).default('every_step'),
});
export type Capture = z.infer<typeof CaptureSchema>;

export const SessionHooksSchema = z.object({
  setup: z
    .string()
    .optional()
    .describe(
      'Command run before each session; its JSON stdout is passed to the user as credentials/context',
    ),
  teardown: z.string().optional(),
  timeoutMs: z.number().int().positive().default(60_000),
});
export type SessionHooks = z.infer<typeof SessionHooksSchema>;

export const ViewportSchema = z.object({
  width: z.number().int().positive().default(1280),
  height: z.number().int().positive().default(800),
});

export const TargetSchema = z
  .object({
    kind: TargetKindSchema.default('web'),
    variants: z.record(SlugSchema, VariantSpecSchema),
    session: SessionHooksSchema.prefault({}),
    capture: CaptureSchema.prefault({}),
    viewport: ViewportSchema.prefault({}),
  })
  .superRefine((t, ctx) => {
    const names = Object.keys(t.variants);
    if (names.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['variants'], message: 'define at least one variant' });
    }
    for (const [name, v] of Object.entries(t.variants)) {
      if ((t.kind === 'web' || t.kind === 'http' || t.kind === 'mcp') && !v.url && !v.image) {
        ctx.addIssue({
          code: 'custom',
          path: ['variants', name],
          message: `${t.kind} variants need a url (or an image to run)`,
        });
      }
      if (t.kind === 'cli' && !v.command && !v.image) {
        ctx.addIssue({
          code: 'custom',
          path: ['variants', name],
          message: 'cli variants need a command',
        });
      }
    }
  });
export type Target = z.infer<typeof TargetSchema>;
export type TargetInput = z.input<typeof TargetSchema>;
