import {
  HarnessSchema,
  type Action,
  type ActResult,
  type DecisionTrace,
  type Harness,
  type Observation,
  type PersonaInstance,
  type Scenario,
  type TargetKind,
} from '@agon/spec';

export function describeLevel(value: number): 'low' | 'medium' | 'high' {
  return value < 0.34 ? 'low' : value < 0.67 ? 'medium' : 'high';
}

export interface SystemPromptInput {
  persona: PersonaInstance;
  scenario: Scenario;
  credentials?: Record<string, string> | undefined;
  /** Target kind; agent-flavoured prompts are used for mcp/http targets and for personas with a harness. */
  kind?: TargetKind | undefined;
}

/** Agent personas (a `harness` block) and agent-facing targets get the agent prompt. */
export function usesAgentPrompt(input: Pick<SystemPromptInput, 'persona' | 'kind'>): boolean {
  return input.persona.harness !== undefined || input.kind === 'mcp' || input.kind === 'http';
}

export function buildSystemPrompt(input: SystemPromptInput): string {
  return usesAgentPrompt(input) ? buildAgentSystemPrompt(input) : buildWebSystemPrompt(input);
}

function targetDescription(kind: TargetKind | undefined): string {
  switch (kind) {
    case 'mcp':
      return 'an MCP server: a catalog of tools, resources and prompts you can call';
    case 'http':
      return 'an HTTP API described by its endpoints';
    case 'cli':
      return 'a command-line tool';
    default:
      return 'a website, through a browser';
  }
}

function describeHarness(h: Harness): string {
  const loop =
    h.loop === 'react'
      ? 'an act-observe loop, one step at a time'
      : h.loop === 'plan-execute'
        ? 'read the whole catalog first, plan, then execute the plan'
        : 'try to finish in a single pass';
  return [
    `Harness: ${loop}`,
    `budget of ${h.maxToolCalls} tool calls`,
    `retries a failed call ${h.retries} time(s) with a fix before changing approach`,
    h.parallelTools ? 'may batch independent calls' : 'one call per turn',
    h.confirmDestructive
      ? 'must stop and ask the user before destructive actions (in this simulation: choose give_up and state the question you would ask)'
      : 'proceeds without asking for confirmation',
    `reads descriptions and schemas: ${describeLevel(h.readsDescriptions)}`,
    `prior exposure to this server: ${describeLevel(h.priorExposure)}`,
  ].join('; ');
}

export function buildAgentSystemPrompt(input: SystemPromptInput): string {
  const { persona, scenario } = input;
  const harness = persona.harness ?? HarnessSchema.parse({});
  const lines: string[] = [
    `You are role-playing one specific AI agent (not a person) that is using ${targetDescription(input.kind)}. Stay in character.`,
    '',
    'WHO YOU ARE',
    persona.summary.trim(),
    `Role: ${persona.traits.role}. Model: ${persona.model}.`,
    `${describeHarness(harness)}.`,
  ];
  if (persona.goals.length) lines.push(`What you optimize for: ${persona.goals.join('; ')}.`);
  if (persona.frustrations.length)
    lines.push(`What trips you up: ${persona.frustrations.join('; ')}.`);
  lines.push('', 'YOUR TASK', scenario.goal.trim());
  const context = Object.entries(scenario.context);
  if (context.length)
    lines.push(`Facts you were given: ${context.map(([k, v]) => `${k} = ${v}`).join('; ')}.`);
  if (input.credentials && Object.keys(input.credentials).length) {
    lines.push(
      `Credentials available to you: ${Object.entries(input.credentials)
        .map(([k, v]) => `${k} = ${v}`)
        .join(', ')}.`,
    );
  }
  lines.push(
    '',
    'HOW TO BEHAVE',
    '- You only know what the catalog and the results of your calls tell you. Never invent tools, parameters or results.',
    "- One action per turn. For tool_call, arguments must be a JSON object that matches the tool's schema.",
    `- When a call fails, read the error. Retry at most ${harness.retries} time(s) with a concrete fix, then change approach.`,
    '- Choose done only when the results you have seen show the task is accomplished.',
    '- Choose give_up when the task cannot be done with these tools, or when your policy requires asking the user; say exactly why. That is how a real agent reports back.',
    '- Report perception (what you notice in the catalog and results), thinking, feeling (for an agent: your confidence), and progress.',
    'Respond with the JSON object only.',
  );
  return lines.join('\n');
}

function buildWebSystemPrompt(input: SystemPromptInput): string {
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

export function renderObservation(observation: Observation, kind: TargetKind = 'web'): string {
  const agentTarget = kind === 'mcp' || kind === 'http';
  const lines: string[] = [`${agentTarget ? 'SERVER' : 'URL'}: ${observation.url}`];
  if (observation.title) lines.push(`TITLE: ${observation.title}`);
  lines.push(
    agentTarget
      ? `CATALOG AND LAST RESULT${observation.truncated ? ' (you only read part of it)' : ''}:`
      : `PAGE TEXT${observation.truncated ? ' (you only took in part of the page)' : ''}:`,
    observation.text || '(nothing readable)',
    '',
  );
  if (observation.interactive.length) {
    lines.push(agentTarget ? 'REFS YOU CAN ACT ON:' : 'THINGS YOU CAN INTERACT WITH:');
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
    lines.push(
      agentTarget ? 'REFS YOU CAN ACT ON: none' : 'THINGS YOU CAN INTERACT WITH: none visible',
    );
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
  kind?: TargetKind | undefined;
}

const ACTIONS_HELP: Record<TargetKind, string> = {
  web: 'Actions: click(ref) · fill(ref, text) · select(ref, value) · press(key) · navigate(url) · scroll(down|up) · back · wait(ms) · give_up(reason) · done(reason).',
  mcp: "Actions: tool_call(ref, arguments) · click(ref) to read a resource or prompt · wait(ms) · give_up(reason) · done(reason). Arguments must be a JSON object matching the tool's schema.",
  http: 'Actions: tool_call(ref, arguments) to call an endpoint · click(ref) to read documentation · wait(ms) · give_up(reason) · done(reason).',
  cli: 'Actions: fill(ref, text) to type a command · press(key) · wait(ms) · give_up(reason) · done(reason).',
};

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
  const kind = input.kind ?? 'web';
  const agentTarget = kind === 'mcp' || kind === 'http';
  lines.push(
    '',
    'WHAT YOU SEE NOW',
    renderObservation(input.observation, kind),
    '',
    ACTIONS_HELP[kind],
    agentTarget
      ? 'Decide your next single action as this agent.'
      : 'Decide your next single action as this person.',
  );
  return lines.join('\n');
}
