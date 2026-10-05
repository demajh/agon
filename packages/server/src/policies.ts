/**
 * Minimal policy engine: a safe evaluator for `policies[].when` expressions and the loop that
 * turns matching policies into Decisions (proposed or executed) with cooldown and daily caps.
 *
 * Grammar (whitespace-insensitive, `and` binds tighter than `or`):
 *
 *   expr   := term ('or' term)*
 *   term   := factor ('and' factor)*
 *   factor := '(' expr ')' | variable op value
 *   op     := '<' | '<=' | '>' | '>=' | '==' | '!='
 *   value  := number | 'string' | "string" | bareword
 *
 * Variables: result.verdict, result.p_best, result.lift, squad.win_rate, squad.runs,
 * squad.mean_lift, squad.p_best_rolling(N).
 */
import { decisions, squads, type Db } from '@agon/db';
import {
  ConfigError,
  durationToMs,
  policyApproval,
  type Decision,
  type Policy,
  type Result,
  type Run,
  type Squad,
} from '@agon/spec';
import type { AppContext } from './context.js';
import { decide, reallocate } from './squads/actions.js';
import { bestComparison, creditedSquads } from './squads/credit.js';
import { rollingPBest } from './squads/history.js';

// --- expression language ------------------------------------------------------------------------

export const COMPARISON_OPS = ['<', '<=', '>', '>=', '==', '!='] as const;
export type ComparisonOp = (typeof COMPARISON_OPS)[number];

export const POLICY_VARIABLES = [
  'result.verdict',
  'result.p_best',
  'result.lift',
  'squad.win_rate',
  'squad.runs',
  'squad.mean_lift',
  'squad.p_best_rolling',
] as const;
export type PolicyVariableName = (typeof POLICY_VARIABLES)[number];

/** Variables that take a numeric argument, e.g. `squad.p_best_rolling(5)`. */
const VARIABLES_WITH_ARG: ReadonlySet<PolicyVariableName> = new Set(['squad.p_best_rolling']);

export interface VariableRef {
  name: PolicyVariableName;
  arg?: number;
}

export type Literal = { kind: 'number'; value: number } | { kind: 'string'; value: string };

export type Expr =
  | { type: 'cmp'; left: VariableRef; op: ComparisonOp; right: Literal }
  | { type: 'and' | 'or'; left: Expr; right: Expr };

export type VariableValue = number | string | undefined;

/** Canonical key of a variable reference, e.g. `squad.p_best_rolling(5)`. */
export function variableKey(ref: VariableRef): string {
  return ref.arg === undefined ? ref.name : `${ref.name}(${ref.arg})`;
}

type Token =
  | { kind: 'ident'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'op'; value: ComparisonOp }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'and' }
  | { kind: 'or' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' });
      i++;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '==' || two === '!=') {
      tokens.push({ kind: 'op', value: two });
      i += 2;
      continue;
    }
    if (ch === '<' || ch === '>') {
      tokens.push({ kind: 'op', value: ch });
      i++;
      continue;
    }
    if (ch === '=') {
      throw new ConfigError(`policy expression: use "==" for equality at position ${i}`);
    }
    if (ch === "'" || ch === '"') {
      const end = source.indexOf(ch, i + 1);
      if (end === -1)
        throw new ConfigError(`policy expression: unterminated string at position ${i}`);
      tokens.push({ kind: 'string', value: source.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const number = /^-?\d+(\.\d+)?([eE][-+]?\d+)?/.exec(source.slice(i));
    if (number) {
      tokens.push({ kind: 'number', value: Number(number[0]) });
      i += number[0].length;
      continue;
    }
    const ident = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(source.slice(i));
    if (ident) {
      const word = ident[0];
      const lower = word.toLowerCase();
      if (lower === 'and') tokens.push({ kind: 'and' });
      else if (lower === 'or') tokens.push({ kind: 'or' });
      else tokens.push({ kind: 'ident', value: word });
      i += word.length;
      continue;
    }
    throw new ConfigError(`policy expression: unexpected character "${ch}" at position ${i}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Expr {
    if (this.tokens.length === 0) throw new ConfigError('policy expression is empty');
    const expr = this.expr();
    if (this.pos < this.tokens.length) {
      throw new ConfigError(
        `policy expression: unexpected token after "${this.describe(this.tokens[this.pos])}"`,
      );
    }
    return expr;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos++];
    if (!token) throw new ConfigError('policy expression: unexpected end of expression');
    return token;
  }

  private describe(token: Token | undefined): string {
    if (!token) return 'end';
    switch (token.kind) {
      case 'ident':
      case 'string':
        return token.value;
      case 'number':
        return String(token.value);
      case 'op':
        return token.value;
      case 'lparen':
        return '(';
      case 'rparen':
        return ')';
      case 'and':
        return 'and';
      case 'or':
        return 'or';
    }
  }

  private expr(): Expr {
    let left = this.term();
    while (this.peek()?.kind === 'or') {
      this.next();
      left = { type: 'or', left, right: this.term() };
    }
    return left;
  }

  private term(): Expr {
    let left = this.factor();
    while (this.peek()?.kind === 'and') {
      this.next();
      left = { type: 'and', left, right: this.factor() };
    }
    return left;
  }

  private factor(): Expr {
    const token = this.next();
    if (token.kind === 'lparen') {
      const inner = this.expr();
      const close = this.next();
      if (close.kind !== 'rparen') throw new ConfigError('policy expression: expected ")"');
      return inner;
    }
    if (token.kind !== 'ident') {
      throw new ConfigError(
        `policy expression: expected a variable, got "${this.describe(token)}"`,
      );
    }
    const left = this.variable(token.value);
    const op = this.next();
    if (op.kind !== 'op') {
      throw new ConfigError(
        `policy expression: expected one of ${COMPARISON_OPS.join(' ')} after ${variableKey(left)}, got "${this.describe(op)}"`,
      );
    }
    const value = this.next();
    let right: Literal;
    if (value.kind === 'number') right = { kind: 'number', value: value.value };
    else if (value.kind === 'string' || value.kind === 'ident')
      right = { kind: 'string', value: value.value };
    else
      throw new ConfigError(
        `policy expression: expected a value after "${op.value}", got "${this.describe(value)}"`,
      );
    if (right.kind === 'string' && op.value !== '==' && op.value !== '!=') {
      throw new ConfigError(
        `policy expression: "${op.value}" needs a numeric value, got "${right.value}"`,
      );
    }
    return { type: 'cmp', left, op: op.value, right };
  }

  private variable(name: string): VariableRef {
    if (!(POLICY_VARIABLES as readonly string[]).includes(name)) {
      throw new ConfigError(
        `policy expression: unknown variable "${name}" (known: ${POLICY_VARIABLES.join(', ')})`,
      );
    }
    const ref: VariableRef = { name: name as PolicyVariableName };
    if (VARIABLES_WITH_ARG.has(ref.name)) {
      if (this.next().kind !== 'lparen')
        throw new ConfigError(`policy expression: ${name} needs an argument, e.g. ${name}(5)`);
      const arg = this.next();
      if (arg.kind !== 'number' || !Number.isInteger(arg.value) || arg.value < 1) {
        throw new ConfigError(`policy expression: ${name} takes a positive integer argument`);
      }
      if (this.next().kind !== 'rparen') throw new ConfigError('policy expression: expected ")"');
      ref.arg = arg.value;
    } else if (this.peek()?.kind === 'lparen') {
      throw new ConfigError(`policy expression: ${name} takes no argument`);
    }
    return ref;
  }
}

/** Parses a `when` expression. Throws `ConfigError` for anything outside the grammar. */
export function parseCondition(source: string): Expr {
  return new Parser(tokenize(source)).parse();
}

/** Every variable an expression reads, deduplicated by canonical key. */
export function referencedVariables(expr: Expr): VariableRef[] {
  const out = new Map<string, VariableRef>();
  const walk = (e: Expr): void => {
    if (e.type === 'cmp') out.set(variableKey(e.left), e.left);
    else {
      walk(e.left);
      walk(e.right);
    }
  };
  walk(expr);
  return [...out.values()];
}

function compare(left: VariableValue, op: ComparisonOp, right: Literal): boolean {
  if (left === undefined) return false;
  if (right.kind === 'string') {
    const l = String(left);
    return op === '==' ? l === right.value : op === '!=' ? l !== right.value : false;
  }
  if (typeof left !== 'number' || Number.isNaN(left)) return false;
  switch (op) {
    case '<':
      return left < right.value;
    case '<=':
      return left <= right.value;
    case '>':
      return left > right.value;
    case '>=':
      return left >= right.value;
    case '==':
      return left === right.value;
    case '!=':
      return left !== right.value;
  }
}

/** Evaluates a parsed expression against resolved variable values (keyed by `variableKey`). */
export function evaluateCondition(expr: Expr, values: ReadonlyMap<string, VariableValue>): boolean {
  switch (expr.type) {
    case 'cmp':
      return compare(values.get(variableKey(expr.left)), expr.op, expr.right);
    case 'and':
      return evaluateCondition(expr.left, values) && evaluateCondition(expr.right, values);
    case 'or':
      return evaluateCondition(expr.left, values) || evaluateCondition(expr.right, values);
  }
}

/** Parses every `when` in a config's policies, reporting the first bad one as `ConfigError`. */
export function validatePolicies(policies: readonly Policy[]): void {
  for (const policy of policies) {
    if (policy.when === undefined) continue;
    try {
      parseCondition(policy.when);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ConfigError(`policy "${policy.id}": ${message}`, {
        policyId: policy.id,
        when: policy.when,
      });
    }
  }
}

// --- variable resolution --------------------------------------------------------------------------

export interface VariableScope {
  result?: Result | undefined;
  squad?: Squad | undefined;
  /** Resolves `squad.p_best_rolling(n)`; defaults to the database history. */
  rolling?: ((n: number) => Promise<number | undefined>) | undefined;
}

/** Looks the referenced variables up for one policy evaluation. Unknown values stay undefined. */
export async function resolveVariables(
  refs: readonly VariableRef[],
  scope: VariableScope,
): Promise<Map<string, VariableValue>> {
  const values = new Map<string, VariableValue>();
  const best = scope.result ? bestComparison(scope.result) : undefined;
  for (const ref of refs) {
    let value: VariableValue;
    switch (ref.name) {
      case 'result.verdict':
        value = scope.result?.decision.verdict;
        break;
      case 'result.p_best':
        value = best?.pBest;
        break;
      case 'result.lift':
        value = best?.lift;
        break;
      case 'squad.win_rate':
        value = scope.squad?.score.winRate;
        break;
      case 'squad.runs':
        value = scope.squad?.score.runs;
        break;
      case 'squad.mean_lift':
        value = scope.squad?.score.meanLift;
        break;
      case 'squad.p_best_rolling':
        value =
          scope.squad && scope.rolling && ref.arg !== undefined
            ? await scope.rolling(ref.arg)
            : undefined;
        break;
    }
    values.set(variableKey(ref), value);
  }
  return values;
}

// --- the engine -----------------------------------------------------------------------------------

export type PolicyTrigger = 'run.completed' | 'result.ready';

export interface PolicyRunInput {
  trigger: PolicyTrigger;
  run: Run;
  result?: Result | undefined;
  /** Now, for the guardrail windows (default: the current time). */
  now?: Date | undefined;
}

export type PolicySkipReason =
  | 'not_matched'
  | 'cooldown'
  | 'max_per_day'
  | 'unknown_squad'
  | 'no_squads'
  | 'unsupported_trigger'
  | 'error';

export interface PolicyOutcome {
  policyId: string;
  action: Policy['then'];
  squadId?: string;
  squadSlug?: string;
  values: Record<string, VariableValue>;
  decision?: Decision;
  skipped?: PolicySkipReason;
  error?: string;
}

const DAY_MS = 24 * 3_600_000;

async function recentDecisions(
  db: Db,
  filter: { kind: Policy['then']; squadId?: string | undefined; policyId?: string | undefined },
  since: number,
): Promise<Decision[]> {
  const page = await decisions.list(db, {
    kind: filter.kind,
    squadId: filter.squadId,
    policyId: filter.policyId,
    limit: 200,
  });
  return page.items.filter((d) => Date.parse(d.createdAt) >= since);
}

/** `cooldown` and `maxPerDay`, judged against decisions of the same kind for the same squad. */
export async function guardrailSkip(
  db: Db,
  policy: Policy,
  target: { squadId?: string | undefined; policyId?: string | undefined },
  now: Date,
): Promise<'cooldown' | 'max_per_day' | undefined> {
  const window = Math.max(durationToMs(policy.cooldown), DAY_MS);
  const recent = await recentDecisions(
    db,
    { kind: policy.then, ...target },
    now.getTime() - window,
  );
  const cooldownSince = now.getTime() - durationToMs(policy.cooldown);
  if (recent.some((d) => Date.parse(d.createdAt) >= cooldownSince)) return 'cooldown';
  const today = recent.filter((d) => Date.parse(d.createdAt) >= now.getTime() - DAY_MS);
  if (today.length >= policy.maxPerDay) return 'max_per_day';
  return undefined;
}

function describeValues(values: ReadonlyMap<string, VariableValue>): string {
  return [...values.entries()]
    .map(([k, v]) => `${k} = ${v === undefined ? 'n/a' : typeof v === 'number' ? v.toFixed(4) : v}`)
    .join(', ');
}

function numericMetrics(values: ReadonlyMap<string, VariableValue>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of values) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  return out;
}

/**
 * Evaluates the run config's policies for one trigger. Every match becomes a Decision: proposed
 * when the policy needs human approval, otherwise approved and executed on the spot.
 */
export async function evaluatePolicies(
  ctx: AppContext,
  input: PolicyRunInput,
): Promise<PolicyOutcome[]> {
  const now = input.now ?? new Date();
  const outcomes: PolicyOutcome[] = [];
  const policies = input.run.config.policies.filter((p) => p.on === input.trigger);
  if (policies.length === 0) return outcomes;
  const credited = creditedSquads(input.run.config);
  const evidenceBase = {
    runIds: [input.run.id],
    resultIds: input.result ? [input.result.id] : [],
  };

  for (const policy of policies) {
    const expr = policy.when === undefined ? undefined : parseCondition(policy.when);
    const refs = expr ? referencedVariables(expr) : [];
    const approval = policyApproval(policy);
    const label = `policy "${policy.id}"${policy.name ? ` (${policy.name})` : ''}`;

    if (policy.then === 'reallocate') {
      const outcome: PolicyOutcome = { policyId: policy.id, action: policy.then, values: {} };
      try {
        const values = await resolveVariables(refs, { result: input.result });
        outcome.values = Object.fromEntries(values);
        if (expr && !evaluateCondition(expr, values)) {
          outcome.skipped = 'not_matched';
        } else {
          const skip = await guardrailSkip(ctx.db, policy, { policyId: policy.id }, now);
          if (skip) outcome.skipped = skip;
          else {
            const { decision } = await reallocate(ctx, {
              floor: policy.floor,
              seed: input.run.seed,
              reason: `${label} on ${input.trigger}${policy.when ? `: ${policy.when} [${describeValues(values)}]` : ''}`,
              actor: 'auto',
              policyId: policy.id,
              approval,
              evidence: { ...evidenceBase, metrics: numericMetrics(values) },
            });
            outcome.decision = decision;
          }
        }
      } catch (error) {
        outcome.skipped = 'error';
        outcome.error = error instanceof Error ? error.message : String(error);
        ctx.logger.warn({ err: error, policyId: policy.id }, 'policy evaluation failed');
      }
      outcomes.push(outcome);
      continue;
    }

    if (credited.size === 0) {
      outcomes.push({ policyId: policy.id, action: policy.then, values: {}, skipped: 'no_squads' });
      continue;
    }
    for (const slug of credited.keys()) {
      const outcome: PolicyOutcome = {
        policyId: policy.id,
        action: policy.then,
        squadSlug: slug,
        values: {},
      };
      try {
        const squad = await squads.findBySlug(ctx.db, slug);
        if (!squad) {
          outcome.skipped = 'unknown_squad';
          outcomes.push(outcome);
          continue;
        }
        outcome.squadId = squad.id;
        const values = await resolveVariables(refs, {
          result: input.result,
          squad,
          rolling: (n) => rollingPBest(ctx.db, slug, n),
        });
        outcome.values = Object.fromEntries(values);
        if (expr && !evaluateCondition(expr, values)) {
          outcome.skipped = 'not_matched';
          outcomes.push(outcome);
          continue;
        }
        const skip = await guardrailSkip(ctx.db, policy, { squadId: squad.id }, now);
        if (skip) {
          outcome.skipped = skip;
          outcomes.push(outcome);
          continue;
        }
        if (policy.then !== 'notify') {
          // Mirror the manual actions: a paused squad is not paused twice, a killed one never acted on.
          const blocked =
            squad.status === 'killed' ||
            (policy.then === 'pause' && squad.status === 'paused') ||
            (policy.then === 'resume' && squad.status === 'active');
          if (blocked) {
            outcome.skipped = 'not_matched';
            outcomes.push(outcome);
            continue;
          }
        }
        outcome.decision = await decide(ctx, {
          kind: policy.then,
          squadId: squad.id,
          policyId: policy.id,
          actor: 'auto',
          rationale: `${label} on ${input.trigger}${policy.when ? `: ${policy.when} [${describeValues(values)}]` : ''} -> ${policy.then} ${slug}`,
          evidence: { ...evidenceBase, metrics: numericMetrics(values) },
          payload: { squad: slug, action: policy.then, trigger: input.trigger, policy: policy.id },
          approval,
        });
      } catch (error) {
        outcome.skipped = 'error';
        outcome.error = error instanceof Error ? error.message : String(error);
        ctx.logger.warn(
          { err: error, policyId: policy.id, squad: slug },
          'policy evaluation failed',
        );
      }
      outcomes.push(outcome);
    }
  }
  return outcomes;
}
