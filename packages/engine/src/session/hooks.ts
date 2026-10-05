import { execFile } from 'node:child_process';
import { AdapterError } from '@agon/spec';

export interface HookOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
}

export interface HookResult {
  /** Parsed JSON object from stdout, with values coerced to strings. Empty when stdout is not JSON. */
  output: Record<string, string>;
  stdout: string;
  stderr: string;
}

/** Runs a session setup/teardown command through the shell and parses JSON from stdout if present. */
export function runHook(command: string, options: HookOptions): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/sh',
      ['-c', command],
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        timeout: options.timeoutMs,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new AdapterError(
              `session hook failed: ${command}: ${error.message}${stderr ? `\n${stderr}` : ''}`,
              {
                cause: error,
                details: { command, stderr },
              },
            ),
          );
          return;
        }
        resolve({ output: parseJsonObject(stdout), stdout, stderr });
      },
    );
  });
}

function parseJsonObject(text: string): Record<string, string> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return {};
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        typeof v === 'string' ? v : JSON.stringify(v),
      ]),
    );
  } catch {
    return {};
  }
}
