import type {
  Action,
  ActResult,
  DecisionTrace,
  Observation,
  PersonaInstance,
  Scenario,
} from '@agon/spec';

export function describeLevel(value: number): 'low' | 'medium' | 'high' {
  return value < 0.34 ? 'low' : value < 0.67 ? 'medium' : 'high';
}

export interface SystemPromptInput {
  persona: PersonaInstance;
  scenario: Scenario;
  credentials?: Record<string, string> | undefined;
}

export function buildSystemPrompt(input: SystemPromptInput): string {
  const { persona, scenario } = input;
  const t = persona.traits;
  const reading =
    t.attention < 0.34
      ? 'skim headlines and buttons'
      : t.attention < 0.67
        ? 'read the main content but skip the fine print'
        : 'read pages thoroughly';
  const lines: string[] = [
    'You are role-playing one specific real person using a website. Stay in character at all times.',
    '',
    'WHO YOU ARE',
    persona.summary.trim(),
    `Role: ${t.role}. Tech comfort: ${t.techProficiency}. Device: ${persona.device}. Locale: ${persona.locale}.`,
    `Patience: ${describeLevel(t.patience)}. You ${reading}. Familiarity with this kind of product: ${describeLevel(t.domainFamiliarity)}. Willingness to share data or pay: ${describeLevel(t.riskTolerance)}. Price sensitivity: ${describeLevel(t.priceSensitivity)}.`,
  ];
  if (persona.goals.length) lines.push(`What you want in general: ${persona.goals.join('; ')}.`);
  if (persona.frustrations.length)
    lines.push(`What annoys you: ${persona.frustrations.join('; ')}.`);
  lines.push('', 'YOUR SITUATION RIGHT NOW', scenario.goal.trim());
  const context = Object.entries(scenario.context);
  if (context.length)
    lines.push(`Facts you know: ${context.map(([k, v]) => `${k} = ${v}`).join('; ')}.`);
  if (input.credentials && Object.keys(input.credentials).length) {
    lines.push(
      `If you need an account or to sign in, these details are yours: ${Object.entries(
        input.credentials,
      )
        .map(([k, v]) => `${k} = ${v}`)
        .join(', ')}.`,
    );
  }
  lines.push(
    '',
    'HOW TO BEHAVE',
    '- Act like this person would, not like a tester. You only know what is on the page in front of you.',
    '- Take exactly one action per turn, using only the refs listed. Prefer the obvious control a person would use.',
    '- Fill forms with plausible details for this person. Do not invent payment details unless clearly a test field.',
    '- Confusion and repeated failures make you frustrated like a real person. When this person would realistically leave, choose give_up and say why.',
    '- Choose done only when you believe you have accomplished what you came to do.',
    '- Be honest in perception (what you actually notice), thinking (why you act), feeling, and progress (did the last action move you toward your goal).',
    'Respond with the JSON object only.',
  );
  return lines.join('\n');
}

export function renderObservation(observation: Observation): string {
  const lines: string[] = [`URL: ${observation.url}`];
  if (observation.title) lines.push(`TITLE: ${observation.title}`);
  lines.push(
    `PAGE TEXT${observation.truncated ? ' (you only took in part of the page)' : ''}:`,
    observation.text || '(nothing readable)',
    '',
  );
  if (observation.interactive.length) {
    lines.push('THINGS YOU CAN INTERACT WITH:');
    for (const el of observation.interactive) {
      const bits: string[] = [`[${el.ref}] ${el.role}`];
      if (el.name) bits.push(`"${el.name}"`);
      if (el.value !== undefined) bits.push(el.value === '' ? '(empty)' : `(value: "${el.value}")`);
      if (el.href) bits.push(`(→ ${el.href})`);
      if (el.checked !== undefined) bits.push(el.checked ? '(checked)' : '(unchecked)');
      if (el.disabled) bits.push('(disabled)');
      lines.push(bits.join(' '));
    }
  } else {
    lines.push('THINGS YOU CAN INTERACT WITH: none visible');
  }
  if (observation.errors.length) {
    lines.push('', 'NOTICES / ERRORS:', ...observation.errors.map((e) => `- ${e}`));
  }
  return lines.join('\n');
}

export function describeAction(action: Action): string {
  switch (action.type) {
    case 'click':
      return `click ${action.ref}`;
    case 'fill':
      return `fill ${action.ref} with "${action.text}"`;
    case 'select':
      return `select "${action.value}" in ${action.ref}`;
    case 'press':
      return `press ${action.key}`;
    case 'navigate':
      return `go to ${action.url}`;
    case 'scroll':
      return `scroll ${action.direction}`;
    case 'back':
      return 'go back';
    case 'wait':
      return `wait ${action.ms}ms`;
    case 'tool_call': {
      const args = JSON.stringify(action.arguments);
      return `call ${action.ref} with ${args.length > 200 ? `${args.slice(0, 200)}…` : args}`;
    }
    case 'give_up':
      return `give up: ${action.reason}`;
    case 'done':
      return `done: ${action.reason}`;
  }
}

export function summarizeStep(index: number, decision: DecisionTrace, result: ActResult): string {
  const outcome = result.ok ? decision.progress : `failed (${result.error ?? 'unknown error'})`;
  return `${index + 1}. ${describeAction(decision.action)} → ${outcome}, felt ${decision.feeling}`;
}

export interface StepMessageInput {
  stepIndex: number;
  maxSteps: number;
  patience: number;
  lastAction?: Action | undefined;
  lastResult?: ActResult | undefined;
  history: readonly string[];
  observation: Observation;
}

const ACTIONS_HELP =
  'Actions: click(ref) · fill(ref, text) · select(ref, value) · press(key) · navigate(url) · scroll(down|up) · back · wait(ms) · give_up(reason) · done(reason).';

export function buildStepMessage(input: StepMessageInput): string {
  const lines: string[] = [
    `Step ${input.stepIndex + 1} (you will not stay here forever; at most ${input.maxSteps} steps).`,
  ];
  if (input.patience < 0.15) lines.push('You are about to give up on this.');
  else if (input.patience < 0.4) lines.push('You are losing patience.');
  if (input.lastAction && input.lastResult) {
    lines.push(
      `Your last action: ${describeAction(input.lastAction)} → ${input.lastResult.ok ? (input.lastResult.navigated ? 'the page changed' : 'done') : `it failed: ${input.lastResult.error ?? 'unknown error'}`}.`,
    );
  }
  if (input.history.length) {
    const recent = input.history.slice(-10);
    lines.push('', 'What you have done so far:', ...recent);
  }
  lines.push(
    '',
    'WHAT YOU SEE NOW',
    renderObservation(input.observation),
    '',
    ACTIONS_HELP,
    'Decide your next single action as this person.',
  );
  return lines.join('\n');
}
