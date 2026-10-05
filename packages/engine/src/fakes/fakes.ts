import type {
  ActResult,
  Action,
  Adapter,
  AdapterSession,
  AgonEvent,
  DecisionTrace,
  EventDraft,
  InteractiveElement,
  Judgement,
  LlmClient,
  LlmObjectRequest,
  LlmObjectResponse,
  LlmRequestBase,
  LlmTextResponse,
  LlmUsage,
  Observation,
  OpenOptions,
  Recorder,
  Result,
  Run,
  Session,
  Step,
  VariantSpec,
} from '@agon/spec';
import { nowIso } from '@agon/spec';

// ---------------------------------------------------------------------------
// A scripted web site the fake adapter serves. Pages are functions of state so
// forms can reflect what the user typed.
// ---------------------------------------------------------------------------

export interface FakeState {
  url: string;
  values: Record<string, string>;
  variant: string;
  errors: string[];
}

export interface FakePage {
  title: string;
  text: string;
  interactive: InteractiveElement[];
}

export interface FakeActOutcome {
  url?: string;
  drafts?: EventDraft[];
  ok?: boolean;
  error?: string;
  pageErrors?: string[];
}

export interface FakeSite {
  pages: Record<string, (state: FakeState) => FakePage>;
  act: (state: FakeState, action: Action) => FakeActOutcome;
}

const intercepted = (event: string, properties: Record<string, unknown> = {}): EventDraft => ({
  timestamp: nowIso(),
  event,
  source: 'intercepted',
  provider: 'posthog',
  properties,
});

/** A miniature "Ledgerly": landing → signup → create project → dashboard. */
export const ledgerlySite: FakeSite = {
  pages: {
    '/': () => ({
      title: 'Ledgerly',
      text: 'Ledgerly. Bookkeeping for small teams. Close your books in an afternoon. Start free, no card required.',
      interactive: [
        { ref: 'e1', role: 'link', name: 'Start free', href: '/signup', disabled: false },
        { ref: 'e2', role: 'link', name: 'Pricing', href: '/pricing', disabled: false },
      ],
    }),
    '/pricing': () => ({
      title: 'Pricing',
      text: 'Starter $19/mo. Team $49/mo. Business $99/mo.',
      interactive: [
        { ref: 'e1', role: 'link', name: 'Start free', href: '/signup', disabled: false },
      ],
    }),
    '/signup': (s) => ({
      title: 'Create your account',
      text: `Create your account.${s.errors.length ? ' ' + s.errors.join(' ') : ''}`,
      interactive: [
        {
          ref: 'e10',
          role: 'textbox',
          name: 'Email',
          value: s.values['e10'] ?? '',
          disabled: false,
        },
        {
          ref: 'e11',
          role: 'textbox',
          name: 'Password',
          value: s.values['e11'] ?? '',
          disabled: false,
        },
        { ref: 'e12', role: 'button', name: 'Create account', disabled: false },
      ],
    }),
    '/onboarding/project': (s) => ({
      title: 'Your first project',
      text: 'Name your first project. You can change it later.',
      interactive: [
        {
          ref: 'e20',
          role: 'textbox',
          name: 'Project name',
          value: s.values['e20'] ?? '',
          disabled: false,
        },
        { ref: 'e21', role: 'button', name: 'Create project', disabled: false },
      ],
    }),
    '/app': () => ({
      title: 'Dashboard',
      text: 'Dashboard. Your project is ready. Welcome aboard.',
      interactive: [
        { ref: 'e30', role: 'link', name: 'Settings', href: '/app/settings', disabled: false },
      ],
    }),
    '/broken': () => ({
      title: 'Oops',
      text: 'Something went wrong.',
      interactive: [{ ref: 'e40', role: 'button', name: 'Retry', disabled: false }],
    }),
  },
  act(state, action) {
    switch (action.type) {
      case 'fill':
        state.values[action.ref] = action.text;
        return {};
      case 'click':
        if (state.url === '/' || state.url === '/pricing') {
          if (action.ref === 'e1')
            return { url: '/signup', drafts: [intercepted('signup_started')] };
          if (action.ref === 'e2')
            return { url: '/pricing', drafts: [intercepted('pricing_viewed')] };
        }
        if (state.url === '/signup' && action.ref === 'e12') {
          if (!state.values['e10'] || !state.values['e11']) {
            state.errors = ['Email and password are required.'];
            return { ok: true };
          }
          state.errors = [];
          return { url: '/onboarding/project', drafts: [intercepted('signup_completed')] };
        }
        if (state.url === '/onboarding/project' && action.ref === 'e21') {
          return {
            url: '/app',
            drafts: [intercepted('project_created', { name: state.values['e20'] ?? 'Untitled' })],
          };
        }
        if (state.url === '/broken' && action.ref === 'e40') {
          return { ok: false, error: 'request failed', pageErrors: ['TypeError: boom'] };
        }
        return { ok: false, error: `nothing happens when clicking ${action.ref}` };
      case 'navigate':
        return { url: action.url.replace(/^https?:\/\/[^/]+/, '') || '/' };
      case 'back':
        return { url: '/' };
      default:
        return {};
    }
  },
};

export class FakeAdapterSession implements AdapterSession {
  readonly kind = 'web' as const;
  readonly state: FakeState;
  private buffer: EventDraft[] = [];
  closed = false;

  constructor(
    private readonly site: FakeSite,
    private readonly origin: string,
    readonly options: OpenOptions,
  ) {
    this.state = {
      url: options.startPath || '/',
      values: {},
      variant: options.variant,
      errors: [],
    };
    this.buffer.push({
      timestamp: nowIso(),
      event: '$pageview',
      source: 'inferred',
      properties: { $current_url: this.absolute() },
    });
  }

  private absolute(): string {
    return `${this.origin}${this.state.url}`;
  }

  private page(): FakePage {
    const render = this.site.pages[this.state.url];
    return render
      ? render(this.state)
      : { title: 'Not found', text: 'Page not found.', interactive: [] };
  }

  async observe(): Promise<Observation> {
    const page = this.page();
    const errors = [...this.state.errors];
    return {
      url: this.absolute(),
      title: page.title,
      text: page.text,
      interactive: page.interactive,
      errors,
      truncated: false,
      hash: `${this.state.url}|${page.text.length}|${page.interactive.map((e) => `${e.ref}:${e.value ?? ''}`).join(',')}`,
      capturedAt: nowIso(),
    };
  }

  async act(action: Action): Promise<ActResult> {
    const outcome = this.site.act(this.state, action);
    if (outcome.pageErrors) this.state.errors = outcome.pageErrors;
    if (outcome.drafts) this.buffer.push(...outcome.drafts);
    const navigated = outcome.url !== undefined && outcome.url !== this.state.url;
    if (outcome.url !== undefined) {
      this.state.url = outcome.url;
      this.state.errors = [];
      this.buffer.push({
        timestamp: nowIso(),
        event: '$pageview',
        source: 'inferred',
        properties: { $current_url: this.absolute() },
      });
    }
    return outcome.ok === false
      ? { ok: false, error: outcome.error ?? 'failed', navigated }
      : { ok: true, navigated };
  }

  drainEvents(): EventDraft[] {
    const out = this.buffer;
    this.buffer = [];
    return out;
  }

  async screenshot(): Promise<Uint8Array | undefined> {
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class FakeAdapter implements Adapter {
  readonly kind = 'web' as const;
  readonly sessions: FakeAdapterSession[] = [];
  constructor(
    private readonly site: FakeSite = ledgerlySite,
    private readonly options: { failOnOpen?: boolean } = {},
  ) {}

  async open(variant: VariantSpec, options: OpenOptions): Promise<AdapterSession> {
    if (this.options.failOnOpen) throw new Error('browser failed to launch');
    const session = new FakeAdapterSession(this.site, variant.url ?? 'http://fake.test', options);
    this.sessions.push(session);
    return session;
  }
}

// ---------------------------------------------------------------------------
// A scripted LLM. The user policy reads the rendered observation out of the
// prompt (URL and refs), so it works no matter how sessions interleave.
// ---------------------------------------------------------------------------

export interface ParsedPrompt {
  path: string;
  refs: Map<string, { role: string; name: string; value?: string }>;
  text: string;
}

export function parsePrompt(message: string): ParsedPrompt {
  const urlLine = message.split('\n').find((l) => l.startsWith('URL: ')) ?? 'URL: http://x/';
  let path = '/';
  try {
    path = new URL(urlLine.slice(5).trim()).pathname;
  } catch {
    path = '/';
  }
  const refs = new Map<string, { role: string; name: string; value?: string }>();
  for (const m of message.matchAll(
    /^\[(e\d+)\] (\w+)(?: "([^"]*)")?(?: \((empty)|value: "([^"]*)"\))?/gm,
  )) {
    const [, ref, role, name, empty, value] = m;
    refs.set(ref as string, {
      role: role as string,
      name: name ?? '',
      ...(empty ? { value: '' } : value !== undefined ? { value } : {}),
    });
  }
  return { path, refs, text: message };
}

export type UserPolicy = (
  prompt: ParsedPrompt,
  request: LlmObjectRequest<unknown>,
) => DecisionTrace;

const trace = (action: Action, extra: Partial<DecisionTrace> = {}): DecisionTrace => ({
  perception: 'I see the page.',
  thinking: 'Doing the obvious thing.',
  feeling: 'confident',
  progress: 'progress',
  ...extra,
  action,
});

/** Completes the Ledgerly flow the way an eager user would. */
export const happyUser: UserPolicy = (p) => {
  if (p.path === '/' || p.path === '/pricing') return trace({ type: 'click', ref: 'e1' });
  if (p.path === '/signup') {
    if (p.refs.get('e10')?.value === '')
      return trace({ type: 'fill', ref: 'e10', text: 'sam@example.com' });
    if (p.refs.get('e11')?.value === '')
      return trace({ type: 'fill', ref: 'e11', text: 'Secret123!' });
    return trace({ type: 'click', ref: 'e12' });
  }
  if (p.path === '/onboarding/project') {
    if (p.refs.get('e20')?.value === '')
      return trace({ type: 'fill', ref: 'e20', text: 'Books 2026' });
    return trace({ type: 'click', ref: 'e21' });
  }
  if (p.path === '/app') return trace({ type: 'done', reason: 'My project exists.' });
  return trace({ type: 'back' }, { progress: 'none', feeling: 'confused' });
};

export interface FakeLlmOptions {
  costPerCall?: number;
  judge?: Omit<Judgement, 'usage'>;
}

export class FakeLlm implements LlmClient {
  readonly requests: LlmObjectRequest<unknown>[] = [];
  constructor(
    private readonly policy: UserPolicy,
    private readonly options: FakeLlmOptions = {},
  ) {}

  private usage(model: string): LlmUsage {
    return {
      model,
      inputTokens: 500,
      outputTokens: 80,
      costUsd: this.options.costPerCall ?? 0.001,
      latencyMs: 1,
      cached: false,
    };
  }

  async generateObject<T>(request: LlmObjectRequest<T>): Promise<LlmObjectResponse<T>> {
    this.requests.push(request as LlmObjectRequest<unknown>);
    const message = request.messages.at(-1)?.content ?? '';
    const raw: unknown =
      request.purpose === 'judge'
        ? (this.options.judge ?? {
            success: message.includes('/app'),
            satisfaction: 4,
            frustration: 1,
            confidence: 0.9,
            summary: 'Reached the dashboard.',
          })
        : this.policy(parsePrompt(message), request as LlmObjectRequest<unknown>);
    return { object: request.schema.parse(raw), usage: this.usage(request.model) };
  }

  async generateText(request: LlmRequestBase): Promise<LlmTextResponse> {
    return { text: '', usage: this.usage(request.model) };
  }
}

/** In-memory recorder that keeps everything for assertions. */
export class MemoryRecorder implements Recorder {
  runs: Run[] = [];
  finishedRuns: { run: Run; result?: Result | undefined }[] = [];
  sessionsStarted: Session[] = [];
  sessionsFinished: Session[] = [];
  steps: { step: Step; screenshot?: Uint8Array | undefined }[] = [];
  recordedEvents: AgonEvent[] = [];
  calls: string[] = [];

  async runStarted(run: Run): Promise<void> {
    this.calls.push('runStarted');
    this.runs.push(structuredClone(run));
  }
  async sessionStarted(session: Session): Promise<void> {
    this.calls.push('sessionStarted');
    this.sessionsStarted.push(structuredClone(session));
  }
  async step(step: Step, screenshot?: Uint8Array): Promise<void> {
    this.calls.push('step');
    this.steps.push({ step: structuredClone(step), screenshot });
  }
  async events(events: AgonEvent[]): Promise<void> {
    this.calls.push('events');
    this.recordedEvents.push(...structuredClone(events));
  }
  async sessionFinished(session: Session): Promise<void> {
    this.calls.push('sessionFinished');
    this.sessionsFinished.push(structuredClone(session));
  }
  async runFinished(run: Run, result?: Result): Promise<void> {
    this.calls.push('runFinished');
    this.finishedRuns.push({ run: structuredClone(run), result });
  }
}
