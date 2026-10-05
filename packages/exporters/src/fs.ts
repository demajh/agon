import { mkdir, open, rename } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { SinkError } from './exporter.js';

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** Writes to a sibling temp file, fsyncs, then renames, so readers never observe a partial file. */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${path}.tmp`;
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
}

/** Append-only file whose writes are serialized in call order and fsynced on close. */
export class AppendFile {
  rows = 0;
  bytes = 0;
  private handle: FileHandle | undefined;
  private opening: Promise<void> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(readonly path: string) {}

  open(): Promise<void> {
    this.opening ??= open(this.path, 'a').then((handle) => {
      this.handle = handle;
    });
    return this.opening;
  }

  /** Appends lines (each already newline-terminated). Concurrent calls never interleave. */
  append(lines: readonly string[]): Promise<void> {
    const task = async (): Promise<void> => {
      if (lines.length === 0) return;
      if (this.closed) throw new SinkError(`append to ${this.path} after close`);
      await this.open();
      const data = lines.join('');
      await (this.handle as FileHandle).appendFile(data);
      this.rows += lines.length;
      this.bytes += Buffer.byteLength(data);
    };
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    if (this.opening) await this.opening.catch(() => undefined);
    const handle = this.handle;
    this.handle = undefined;
    if (!handle) return;
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
