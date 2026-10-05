import { z } from 'zod';
import { IdSchema, SlugSchema, TimestampSchema, UnitSchema } from './common.js';

export const SquadStatusSchema = z.enum(['active', 'paused', 'killed']);
export type SquadStatus = z.infer<typeof SquadStatusSchema>;

export const TicketSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('linear'),
    teamId: z.string().min(1),
    label: z.string().default('agon:paused'),
  }),
  z.object({
    kind: z.literal('jira'),
    projectKey: z.string().min(1),
    label: z.string().default('agon-paused'),
  }),
  z.object({
    kind: z.literal('github'),
    repo: z.string().min(1),
    label: z.string().default('agon:paused'),
  }),
]);
export type TicketSource = z.infer<typeof TicketSourceSchema>;

export const SquadScoreSchema = z.object({
  runs: z.number().int().nonnegative().default(0),
  wins: z.number().int().nonnegative().default(0),
  winRate: UnitSchema.default(0),
  meanLift: z.number().default(0),
  costUsd: z.number().nonnegative().default(0),
});
export type SquadScore = z.infer<typeof SquadScoreSchema>;

export const SquadSchema = z.object({
  id: IdSchema,
  slug: SlugSchema,
  name: z.string().min(1),
  status: SquadStatusSchema.default('active'),
  controlUrl: z.url().optional().describe('Webhook that receives Squad Control Protocol messages'),
  ticketSource: TicketSourceSchema.optional(),
  allocation: UnitSchema.default(0).describe(
    'Share of work or compute currently routed to this squad',
  ),
  score: SquadScoreSchema.prefault({}),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Squad = z.infer<typeof SquadSchema>;

/** Message Agon POSTs to a squad's controlUrl. Orchestrators implement this one endpoint. */
export const SquadControlMessageSchema = z.object({
  action: z.enum(['pause', 'resume', 'kill', 'reallocate']),
  squadId: IdSchema,
  squad: SlugSchema,
  allocation: UnitSchema.optional(),
  reason: z.string(),
  decisionId: IdSchema,
  evidenceUrl: z.url().optional(),
  sentAt: TimestampSchema,
});
export type SquadControlMessage = z.infer<typeof SquadControlMessageSchema>;
