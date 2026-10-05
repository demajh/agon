import { AgonEventSchema, ValidationError } from '@agon/spec';
import type { AgonEvent, EventSource } from '@agon/spec';
import { and, asc, eq, gt, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../client.js';
import { guard } from '../errors.js';
import {
  TimeIdCursorSchema,
  chunk,
  clampLimit,
  compact,
  decodeCursor,
  parseRow,
  toDate,
  toIso,
  toPage,
} from '../internal.js';
import { events } from '../schema.js';
import type { EventRow } from '../schema.js';
import type { Page, PageOptions } from '../types.js';

const LIMITS = { default: 200, max: 1000 };
const INSERT_CHUNK = 500;

export interface ListEventsOptions extends PageOptions {
  event?: string;
  source?: EventSource;
}

export function toEvent(row: EventRow): AgonEvent {
  return parseRow(
    AgonEventSchema,
    compact({
      id: row.id,
      runId: row.runId,
      sessionId: row.sessionId,
      timestamp: toIso(row.timestamp),
      event: row.event,
      distinctId: row.distinctId,
      source: row.source,
      provider: row.provider ?? undefined,
      properties: row.properties,
    }),
    'event',
    row.id,
  );
}

function toRow(event: AgonEvent) {
  return {
    id: event.id,
    runId: event.runId,
    sessionId: event.sessionId,
    timestamp: toDate(event.timestamp),
    event: event.event,
    distinctId: event.distinctId,
    source: event.source,
    provider: event.provider ?? null,
    properties: event.properties,
  };
}

/**
 * Inserts events in bulk; all or nothing. Every event is re-validated first so nothing without the
 * simulation markers can ever be stored. Returns how many were inserted.
 */
export async function insertMany(db: Db, items: AgonEvent[]): Promise<number> {
  if (items.length === 0) return 0;
  const rows = items.map((item) => {
    const parsed = AgonEventSchema.safeParse(item);
    if (!parsed.success) {
      throw new ValidationError(
        `event ${item.id} is invalid:\n${z.prettifyError(parsed.error)}`,
        parsed.error.issues,
      );
    }
    return toRow(parsed.data);
  });
  const batches = chunk(rows, INSERT_CHUNK);
  await guard(async () => {
    if (batches.length === 1) {
      await db.insert(events).values(batches[0] ?? []);
      return;
    }
    await db.transaction(async (tx) => {
      for (const batch of batches) await tx.insert(events).values(batch);
    });
  });
  return items.length;
}

/** Events of a session in time order. */
export async function listBySession(db: Db, sessionId: string): Promise<AgonEvent[]> {
  const rows = await db
    .select()
    .from(events)
    .where(eq(events.sessionId, sessionId))
    .orderBy(asc(events.timestamp), asc(events.id));
  return rows.map(toEvent);
}

/** Events of a run in time order, paginated. */
export async function listByRun(
  db: Db,
  runId: string,
  options: ListEventsOptions = {},
): Promise<Page<AgonEvent>> {
  const limit = clampLimit(options.limit, LIMITS);
  const cursor =
    options.cursor === undefined ? undefined : decodeCursor(options.cursor, TimeIdCursorSchema);
  const rows = await db
    .select()
    .from(events)
    .where(
      and(
        eq(events.runId, runId),
        options.event === undefined ? undefined : eq(events.event, options.event),
        options.source === undefined ? undefined : eq(events.source, options.source),
        cursor === undefined
          ? undefined
          : or(
              gt(events.timestamp, toDate(cursor.t)),
              and(eq(events.timestamp, toDate(cursor.t)), gt(events.id, cursor.i)),
            ),
      ),
    )
    .orderBy(asc(events.timestamp), asc(events.id))
    .limit(limit + 1);
  return toPage(rows.map(toEvent), limit, (last) => ({ t: last.timestamp, i: last.id }));
}
