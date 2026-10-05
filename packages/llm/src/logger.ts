/**
 * Structured logger contract used by `@agon/llm`. It is a strict subset of pino's `Logger`
 * (including child loggers), so a pino instance can be passed straight through. When no logger
 * is supplied the client is silent.
 */
export interface LlmLogger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export const noopLogger: LlmLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** A compact, JSON-safe description of an error for log lines and `details` payloads. */
export function errorSummary(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const out: Record<string, unknown> = { name: error.name, message: error.message };
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === 'number') out['statusCode'] = statusCode;
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') out['code'] = code;
    return out;
  }
  return { message: String(error) };
}
