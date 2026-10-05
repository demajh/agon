import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { LlmError, ModelRefSchema, parseModelRef } from '@agon/spec';
import type { ModelRef } from '@agon/spec';

/** A concrete AI SDK language model (never a bare gateway id string). */
export type LanguageModelInstance = Exclude<LanguageModel, string>;

export const LLM_PROVIDERS = ['anthropic', 'openai', 'openai-compatible', 'local'] as const;
export type LlmProviderId = (typeof LLM_PROVIDERS)[number];

export interface LlmProviderSettings {
  anthropic?: { apiKey: string; baseURL?: string };
  openai?: { apiKey: string; baseURL?: string };
  /** Any OpenAI-compatible server (vLLM, Ollama, LM Studio, a proxy). `local/<model>` routes here too. */
  openaiCompatible?: { baseURL: string; apiKey?: string; name?: string };
}

export const PROVIDER_ENV_VARS = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openaiCompatibleBaseUrl: 'OPENAI_COMPATIBLE_BASE_URL',
  openaiCompatibleApiKey: 'OPENAI_COMPATIBLE_API_KEY',
} as const;

type Env = Record<string, string | undefined>;

/** Provider settings from the environment; absent variables leave the provider unconfigured. */
export function providerSettingsFromEnv(env: Env = process.env): LlmProviderSettings {
  const settings: LlmProviderSettings = {};
  const anthropicKey = env[PROVIDER_ENV_VARS.anthropic];
  if (anthropicKey) settings.anthropic = { apiKey: anthropicKey };
  const openaiKey = env[PROVIDER_ENV_VARS.openai];
  if (openaiKey) settings.openai = { apiKey: openaiKey };
  const baseURL = env[PROVIDER_ENV_VARS.openaiCompatibleBaseUrl];
  if (baseURL) {
    const apiKey = env[PROVIDER_ENV_VARS.openaiCompatibleApiKey];
    settings.openaiCompatible = { baseURL, ...(apiKey ? { apiKey } : {}) };
  }
  return settings;
}

/** Validates a `<provider>/<model>` reference, throwing `LlmError` with the expected format. */
export function assertModelRef(ref: string): ModelRef {
  const parsed = ModelRefSchema.safeParse(ref);
  if (!parsed.success) {
    throw new LlmError(
      `invalid model reference "${ref}": expected "<provider>/<model>", e.g. anthropic/claude-sonnet-5-5`,
      { status: 400, details: { model: ref } },
    );
  }
  return parsed.data;
}

/**
 * Maps model references to AI SDK model instances. Providers are created lazily on first use, so
 * a client configured for one provider never needs credentials for another, and replay mode
 * needs none at all.
 */
export class ModelRouter {
  private anthropic?: ReturnType<typeof createAnthropic>;
  private openai?: ReturnType<typeof createOpenAI>;
  private openaiCompatible?: ReturnType<typeof createOpenAICompatible>;
  private readonly models = new Map<string, LanguageModelInstance>();

  constructor(
    private readonly settings: LlmProviderSettings,
    overrides: Record<string, LanguageModelInstance> = {},
  ) {
    for (const [ref, model] of Object.entries(overrides)) this.models.set(ref, model);
  }

  resolve(ref: ModelRef): LanguageModelInstance {
    const cached = this.models.get(ref);
    if (cached) return cached;
    const { provider, model } = parseModelRef(ref);
    const instance = this.create(provider, model, ref);
    this.models.set(ref, instance);
    return instance;
  }

  private create(provider: string, model: string, ref: ModelRef): LanguageModelInstance {
    switch (provider as LlmProviderId) {
      case 'anthropic': {
        const settings = this.settings.anthropic;
        if (!settings?.apiKey) {
          throw missingCredentials(
            ref,
            provider,
            PROVIDER_ENV_VARS.anthropic,
            'providers.anthropic.apiKey',
          );
        }
        this.anthropic ??= createAnthropic({
          apiKey: settings.apiKey,
          ...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
        });
        return this.anthropic.languageModel(model);
      }
      case 'openai': {
        const settings = this.settings.openai;
        if (!settings?.apiKey) {
          throw missingCredentials(
            ref,
            provider,
            PROVIDER_ENV_VARS.openai,
            'providers.openai.apiKey',
          );
        }
        this.openai ??= createOpenAI({
          apiKey: settings.apiKey,
          ...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
        });
        return this.openai.languageModel(model);
      }
      case 'openai-compatible':
      case 'local': {
        const settings = this.settings.openaiCompatible;
        if (!settings?.baseURL) {
          throw missingCredentials(
            ref,
            provider,
            `${PROVIDER_ENV_VARS.openaiCompatibleBaseUrl} (plus ${PROVIDER_ENV_VARS.openaiCompatibleApiKey} if the server needs a key)`,
            'providers.openaiCompatible.baseURL',
          );
        }
        this.openaiCompatible ??= createOpenAICompatible({
          baseURL: settings.baseURL,
          name: settings.name ?? 'openai-compatible',
          ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
        });
        return this.openaiCompatible.languageModel(model);
      }
      default:
        throw new LlmError(
          `unknown LLM provider "${provider}" in model "${ref}": expected one of ${LLM_PROVIDERS.join(', ')}`,
          { status: 400, details: { model: ref, provider, known: [...LLM_PROVIDERS] } },
        );
    }
  }
}

function missingCredentials(
  ref: ModelRef,
  provider: string,
  envVar: string,
  option: string,
): LlmError {
  return new LlmError(
    `provider "${provider}" is not configured for model "${ref}": set ${envVar} or pass ${option} to createLlmClient()`,
    { status: 400, details: { model: ref, provider, envVar } },
  );
}
