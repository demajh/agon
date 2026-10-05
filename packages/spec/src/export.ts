import { z } from 'zod';
import { SlugSchema } from './common.js';

export const ExportSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('jsonl'), path: z.string().min(1).default('./agon-out') }),
  z.object({ type: z.literal('parquet'), path: z.string().min(1).default('./agon-out') }),
  z.object({
    type: z.literal('posthog'),
    projectApiKey: z.string().min(1),
    host: z.url().default('https://us.i.posthog.com'),
    experimentKey: SlugSchema.optional().describe('Feature-flag key so PostHog Experiments can read the results'),
  }),
  z.object({
    type: z.literal('amplitude'),
    apiKey: z.string().min(1),
    serverUrl: z.url().default('https://api2.amplitude.com/2/httpapi'),
  }),
]);
export type ExportConfig = z.infer<typeof ExportSchema>;
export type ExportConfigInput = z.input<typeof ExportSchema>;
