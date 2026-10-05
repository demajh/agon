import { createHash } from 'node:crypto';
import { ObservationSchema } from '@agon/spec';
import type { InteractiveElement, Observation } from '@agon/spec';

export const DEFAULT_MAX_INTERACTIVE = 40;
export const DEFAULT_MAX_TEXT_CHARS = 4000;

/** What the page script hands back before truncation and hashing. */
export interface RawPageState {
  url: string;
  title: string;
  text: string;
  interactive: InteractiveElement[];
}

export interface BuildObservationOptions {
  maxInteractive?: number;
  maxTextChars?: number;
  errors?: string[];
  capturedAt?: string;
}

/**
 * Whitespace-normalises readable text: one space inside a line, lines trimmed, runs of blank lines
 * collapsed to a single blank line. Line breaks are kept because `innerText` already puts headings,
 * paragraphs and landmarks on their own lines.
 */
export function normalizeText(raw: string): string {
  const lines = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[   ]/g, ' ')
    .replace(/[​‌‍﻿]/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim());
  const out: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line === '') {
      blankRun += 1;
      if (blankRun === 1 && out.length > 0) out.push('');
    } else {
      blankRun = 0;
      out.push(line);
    }
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/**
 * Cuts `text` to at most `max` characters, preferring a whitespace boundary at or after `minKeep`
 * (default 80% of `max`) so the cut does not split a word.
 */
export function cutText(text: string, max: number, minKeep = Math.floor(max * 0.8)): string {
  if (text.length <= max) return text;
  const hard = text.slice(0, Math.max(0, max));
  const boundary = Math.max(hard.lastIndexOf('\n'), hard.lastIndexOf(' '));
  const cut = boundary >= Math.max(0, minKeep) ? hard.slice(0, boundary) : hard;
  return cut.trimEnd();
}

/** sha1 over url, readable text and the (role, name, value) of every interactive element. */
export function observationHash(
  url: string,
  text: string,
  interactive: readonly Pick<InteractiveElement, 'role' | 'name' | 'value'>[],
): string {
  const hash = createHash('sha1');
  hash.update(url);
  hash.update('\n');
  hash.update(text);
  hash.update('\n');
  hash.update(interactive.map((e) => `${e.role}|${e.name}|${e.value ?? ''}`).join('\n'));
  return hash.digest('hex');
}

function positiveInt(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : undefined;
}

/**
 * Turns a raw page state into the `Observation` the engine consumes: normalised text cut to
 * `maxTextChars`, the first `maxInteractive` elements in document order, and a hash of what is
 * returned (so identical views hash identically regardless of what lies below the cut).
 */
export function buildObservation(
  raw: RawPageState,
  options: BuildObservationOptions = {},
): Observation {
  const maxInteractive = positiveInt(options.maxInteractive) ?? DEFAULT_MAX_INTERACTIVE;
  const maxTextChars = positiveInt(options.maxTextChars) ?? DEFAULT_MAX_TEXT_CHARS;
  const fullText = normalizeText(raw.text);
  const text = cutText(fullText, maxTextChars);
  const interactive = raw.interactive.slice(0, maxInteractive);
  const truncated = text.length < fullText.length || interactive.length < raw.interactive.length;
  return ObservationSchema.parse({
    url: raw.url,
    title: raw.title,
    text,
    interactive,
    errors: options.errors ?? [],
    truncated,
    hash: observationHash(raw.url, text, interactive),
    capturedAt: options.capturedAt ?? new Date().toISOString(),
  });
}
