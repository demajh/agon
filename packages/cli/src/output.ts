import pc from 'picocolors';

export interface OutputOptions {
  json: boolean;
  color: boolean;
}

/** Everything the CLI prints goes through here so tests can capture it and --json stays clean. */
export class Output {
  readonly lines: string[] = [];
  constructor(
    readonly options: OutputOptions,
    private readonly write: (text: string) => void = (text) => process.stdout.write(text),
  ) {}

  private paint(fn: (s: string) => string, text: string): string {
    return this.options.color ? fn(text) : text;
  }

  text(line = ''): void {
    this.lines.push(line);
    this.write(`${line}\n`);
  }

  heading(text: string): void {
    this.text(this.paint(pc.bold, text));
  }

  ok(text: string): void {
    this.text(`${this.paint(pc.green, '✓')} ${text}`);
  }

  warn(text: string): void {
    this.text(`${this.paint(pc.yellow, '!')} ${text}`);
  }

  fail(text: string): void {
    this.text(`${this.paint(pc.red, '✗')} ${text}`);
  }

  dim(text: string): string {
    return this.paint(pc.dim, text);
  }

  json(value: unknown): void {
    this.text(JSON.stringify(value, null, 2));
  }

  table(headers: string[], rows: (string | number)[][]): void {
    const cells = [headers, ...rows.map((r) => r.map(String))];
    const widths = headers.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? '').length)));
    const render = (r: string[]): string =>
      r
        .map((c, i) => c.padEnd(widths[i] ?? 0))
        .join('  ')
        .trimEnd();
    this.text(this.paint(pc.bold, render(headers)));
    for (const row of rows) this.text(render(row.map(String)));
  }
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(value < 0.1 ? 4 : 2)}`;
}
