import { DecisionTraceSchema, type DecisionTrace, type LlmClient, type LlmUsage } from '@agon/spec';

export interface UserAgentDeps {
  llm: LlmClient;
  model: string;
  temperature: number;
}

export interface DecideInput {
  system: string;
  message: string;
  cacheKey?: string | undefined;
}

export interface Decision {
  decision: DecisionTrace;
  usage: LlmUsage;
}

/** One perceive → decide call. The schema is the contract; the LLM layer validates against it. */
export async function decideNextAction(deps: UserAgentDeps, input: DecideInput): Promise<Decision> {
  const response = await deps.llm.generateObject({
    model: deps.model,
    system: input.system,
    messages: [{ role: 'user', content: input.message }],
    schema: DecisionTraceSchema,
    schemaName: 'decision',
    temperature: deps.temperature,
    purpose: 'act',
    ...(input.cacheKey === undefined ? {} : { cacheKey: input.cacheKey }),
  });
  return { decision: response.object, usage: response.usage };
}
