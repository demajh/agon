import { randomBytes } from 'node:crypto';
import type { ParsedPrompt, UserPolicy } from '@agon/engine/fakes';
import type { Action, DecisionTrace, Feeling, Progress } from '@agon/spec';

/** Satisfies the demo app's rule: at least 8 characters with a letter and a digit. */
export const E2E_PASSWORD = 'Correct-horse-7';
export const E2E_COMPANY = 'Harbor Lane Coffee';
export const E2E_PROJECT_NAME = 'Harbor Lane Books';

/** Unique per signup, so many sessions can register against one in-memory demo app. */
export function uniqueEmail(): string {
  return `sim-${randomBytes(4).toString('hex')}@example.com`;
}

export interface Control {
  ref: string;
  role: string;
  name: string;
  /** `''` when the prompt shows "(empty)", the text when it shows `(value: "…")`, else undefined. */
  value: string | undefined;
}

const CONTROL_LINE_RE = /^\[(e\d+)\] \w+(?: "[^"]*")?(?: \((empty)\)| \(value: "([^"]*)"\))?/gm;

/**
 * The interactive elements of a step prompt. `parsePrompt` supplies ref, role and name; the value
 * is re-read from the raw lines because its regex only recognises "(empty)", never `(value: "…")`,
 * and choosing in a `<select>` needs to know what is currently selected.
 */
export function readControls(prompt: ParsedPrompt): Control[] {
  const values = new Map<string, string | undefined>();
  for (const match of prompt.text.matchAll(CONTROL_LINE_RE)) {
    const [, ref, empty, value] = match;
    values.set(ref as string, empty !== undefined ? '' : value);
  }
  return [...prompt.refs.entries()].map(([ref, element]) => ({
    ref,
    role: element.role,
    name: element.name,
    value: values.get(ref),
  }));
}

const OPTIONS_RE = /\(options: (.*)$/;
const PLACEHOLDER_RE = /^choose\b/i;

/**
 * Option labels the web adapter appends to a select's name as "(options: A, B, C)". A name the
 * adapter clipped (ending in "…") loses its last label, which may be cut mid-word.
 */
export function selectOptions(name: string): string[] {
  const match = OPTIONS_RE.exec(name);
  if (!match) return [];
  const labels = (match[1] ?? '')
    .replace(/[)…]+$/, '')
    .split(',')
    .map((label) => label.trim())
    .filter((label) => label !== '');
  if (name.endsWith('…')) labels.pop();
  return labels;
}

/** The first option that is not a "Choose …" placeholder. */
export function firstRealOption(name: string): string | undefined {
  return selectOptions(name).find((label) => !PLACEHOLDER_RE.test(label));
}

function needsChoice(control: Control): boolean {
  return (
    control.role === 'combobox' &&
    (control.value === undefined || control.value === '' || PLACEHOLDER_RE.test(control.value))
  );
}

interface Mood {
  feeling?: Feeling;
  progress?: Progress;
}

function decide(
  action: Action,
  perception: string,
  thinking: string,
  mood: Mood = {},
): DecisionTrace {
  return {
    perception,
    thinking,
    feeling: mood.feeling ?? 'confident',
    progress: mood.progress ?? 'progress',
    action,
  };
}

function giveUp(perception: string, reason: string): DecisionTrace {
  return decide({ type: 'give_up', reason }, perception, 'This is not going anywhere.', {
    feeling: 'frustrated',
    progress: 'none',
  });
}

const textbox = (controls: Control[], name: RegExp): Control | undefined =>
  controls.find((c) => c.role === 'textbox' && name.test(c.name));
const button = (controls: Control[], name: RegExp): Control | undefined =>
  controls.find((c) => (c.role === 'button' || c.role === 'link') && name.test(c.name));

function fillIfEmpty(
  control: Control | undefined,
  text: string,
  what: string,
  path: string,
): DecisionTrace | undefined {
  if (control === undefined)
    return giveUp(`There is no ${what} field here.`, `no ${what} field on ${path}`);
  if (control.value !== '') return undefined;
  return decide(
    { type: 'fill', ref: control.ref, text },
    `The ${what} field is empty.`,
    `I will type my ${what}.`,
  );
}

function chooseIfNeeded(controls: Control[], path: string): DecisionTrace | undefined {
  const select = controls.find(needsChoice);
  if (select === undefined) return undefined;
  const option = firstRealOption(select.name);
  if (option === undefined) {
    return giveUp(
      `The "${select.name}" dropdown offers nothing to pick.`,
      `no options in ${select.name} on ${path}`,
    );
  }
  return decide(
    { type: 'select', ref: select.ref, value: option },
    `A dropdown still shows its placeholder.`,
    `"${option}" is the first real choice; good enough for me.`,
  );
}

/** How long the user looks over a form after typing before submitting it. */
export const REVIEW_PAUSE_MS = 400;

/**
 * Submits a form. If the user just typed into it, they first pause to look it over, as a person
 * would. This also keeps the demo app's focus-triggered `signup_started` event honest: its shim
 * batches events for 250 ms, and a batch still pending when the form navigates away is flushed on
 * `pagehide` as a keepalive request, which the browser issues outside the adapter's interception.
 */
function submit(
  prompt: ParsedPrompt,
  controls: Control[],
  name: RegExp,
  why: string,
): DecisionTrace {
  const control = button(controls, name);
  if (control === undefined) {
    return giveUp(
      `I cannot find a ${name.source} button.`,
      `no ${name.source} button on ${prompt.path}`,
    );
  }
  if (/^Your last action: fill /m.test(prompt.text)) {
    return decide(
      { type: 'wait', ms: REVIEW_PAUSE_MS },
      'Everything I typed is in place.',
      'One quick look over the form before I send it.',
    );
  }
  return decide({ type: 'click', ref: control.ref }, `There is a "${control.name}" button.`, why);
}

const FAILED_ACTION_RE = /^Your last action: (.+) → it failed: (.+)$/m;

/** Unknown page: look further down once, then leave with a reason that names the page. */
function lost(prompt: ParsedPrompt): DecisionTrace {
  const scrolled = /^Your last action: scroll down/m.test(prompt.text);
  if (!scrolled) {
    return decide(
      { type: 'scroll', direction: 'down' },
      `I am on ${prompt.path} and nothing here looks like what I expected.`,
      'Maybe what I need is further down the page.',
      { feeling: 'confused', progress: 'none' },
    );
  }
  return giveUp(
    `Still nothing useful on ${prompt.path}.`,
    `ledgerly-user has no script for ${prompt.path}`,
  );
}

/**
 * Completes Ledgerly's signup and onboarding the way an eager, attentive user would: one action per
 * step, keyed on the page path and the accessible names the web adapter reports. The policy is
 * stateless, so sessions can interleave freely; anything it does not recognise ends the session
 * with `give_up` and a reason, so a regression fails loudly instead of looping to the step limit.
 */
export const ledgerlyUser: UserPolicy = (prompt) => {
  const { path } = prompt;
  const controls = readControls(prompt);

  const failed = FAILED_ACTION_RE.exec(prompt.text);
  if (failed) {
    return giveUp(
      `What I just tried did not work: ${failed[2] ?? 'unknown error'}.`,
      `action failed on ${path}: ${failed[1] ?? '?'} → ${failed[2] ?? 'unknown error'}`,
    );
  }
  if (prompt.text.includes('There is a problem')) {
    const detail = /There is a problem\n(.+)/.exec(prompt.text)?.[1] ?? 'unknown validation error';
    return giveUp('The form came back with an error.', `form rejected on ${path}: ${detail}`);
  }

  if (path === '/' || path === '/pricing') {
    const start = button(controls, /^start free$/i);
    if (start === undefined) {
      return giveUp('No obvious way to start.', `no "Start free" link on ${path}`);
    }
    return decide(
      { type: 'click', ref: start.ref },
      'Ledgerly says it is free for one project, no card required.',
      'Start free is exactly what I came for.',
    );
  }

  if (path === '/signup') {
    return (
      fillIfEmpty(textbox(controls, /email/i), uniqueEmail(), 'email', path) ??
      fillIfEmpty(textbox(controls, /^password$/i), E2E_PASSWORD, 'password', path) ??
      fillIfEmpty(textbox(controls, /company/i), E2E_COMPANY, 'company name', path) ??
      submit(prompt, controls, /^create account$/i, 'Everything is filled in; create the account.')
    );
  }

  if (path === '/onboarding/verify') {
    const code =
      /your code is (\d{6})/i.exec(prompt.text)?.[1] ?? /\b(\d{6})\b/.exec(prompt.text)?.[1];
    if (code === undefined) {
      return giveUp(
        'I never got a code and see none on the page.',
        `no verification code visible on ${path}`,
      );
    }
    return (
      fillIfEmpty(textbox(controls, /code/i), code, 'verification code', path) ??
      submit(prompt, controls, /^verify and continue$/i, 'The code is in; continue.')
    );
  }

  if (path === '/onboarding/profile') {
    return (
      chooseIfNeeded(controls, path) ??
      submit(prompt, controls, /^continue$/i, 'Role and team size are set; continue.')
    );
  }

  if (path === '/onboarding/connect-bank') {
    return submit(
      prompt,
      controls,
      /^skip for now$/i,
      'I am not connecting a bank before I have seen the product.',
    );
  }

  if (path === '/onboarding/invite') {
    return submit(
      prompt,
      controls,
      /^continue$/i,
      'No teammates yet; continue without inviting anyone.',
    );
  }

  if (path === '/onboarding/project') {
    return (
      fillIfEmpty(textbox(controls, /^project name$/i), E2E_PROJECT_NAME, 'project name', path) ??
      chooseIfNeeded(controls, path) ??
      submit(
        prompt,
        controls,
        /^create project$/i,
        'Name and currency are set; create the project.',
      )
    );
  }

  if (path === '/app') {
    return decide(
      { type: 'done', reason: 'My first project exists and I am on the dashboard.' },
      'The dashboard lists my project.',
      'That is what I came to do.',
    );
  }

  return lost(prompt);
};
