/** Pure helpers for the stdio transport: turning `variant.command` into an argv and back. */

/**
 * Splits a command line the way a POSIX shell tokenises it: whitespace separates arguments,
 * single quotes keep everything literal, double quotes allow `\"`, `\\`, `\$` and `` \` ``
 * escapes, and a backslash outside quotes escapes the next character. Nothing is expanded: no
 * variables, globs, pipes or redirections. The first token is the executable, the rest are its
 * arguments. Throws a plain Error on an unterminated quote.
 */
export function parseCommand(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | undefined;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command.charAt(i);
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = undefined;
        continue;
      }
      if (ch === '\\' && i + 1 < command.length) {
        const next = command.charAt(i + 1);
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          current += next;
          i += 1;
          continue;
        }
      }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      current += command.charAt(i + 1);
      i += 1;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        args.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }

  if (quote !== undefined) {
    throw new Error(`unterminated ${quote === "'" ? 'single' : 'double'} quote in command`);
  }
  if (inToken) args.push(current);
  return args;
}

const SAFE_ARG_RE = /^[A-Za-z0-9_./:@%+=,-]+$/;

/** Inverse of `parseCommand`: double-quotes every argument that needs it. */
export function formatCommand(args: readonly string[]): string {
  return args
    .map((arg) => (SAFE_ARG_RE.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, '\\$1')}"`))
    .join(' ');
}
