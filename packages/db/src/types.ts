import { IdSchema, SlugSchema, TimestampSchema, VariantSpecSchema } from '@agon/spec';
import { z } from 'zod';
import { API_KEY_ROLES } from './schema.js';

/**
 * Types that are stored by `@agon/db` but have no counterpart in `@agon/spec` yet (variants as
 * rows, API keys, pagination). Everything that does exist in the spec is imported from there.
 */

export { API_KEY_ROLES };
export const ApiKeyRoleSchema = z.enum(API_KEY_ROLES);
export type ApiKeyRole = z.infer<typeof ApiKeyRoleSchema>;

/** An API key as stored: only the SHA-256 hash of the secret is kept. */
export const ApiKeySchema = z.object({
  id: IdSchema,
  keyHash: z.string().length(64),
  role: ApiKeyRoleSchema,
  squadId: IdSchema.optional(),
  label: z.string(),
  createdAt: TimestampSchema,
  lastUsedAt: TimestampSchema.optional(),
  revokedAt: TimestampSchema.optional(),
});
export type ApiKey = z.infer<typeof ApiKeySchema>;

/** A registered deployment of an environment's target. */
export const VariantSchema = z.object({
  id: IdSchema,
  environmentId: IdSchema,
  name: SlugSchema,
  spec: VariantSpecSchema,
  squadId: IdSchema.optional(),
  gitRef: z.string().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Variant = z.infer<typeof VariantSchema>;

export interface PageOptions {
  /** Rows per page; clamped to the repository's maximum. */
  limit?: number;
  /** Opaque cursor returned as `nextCursor` by the previous page. */
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  /** Present when more rows exist; pass it back as `cursor`. */
  nextCursor?: string;
}
