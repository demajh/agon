/**
 * Counting semaphore used to cap in-flight provider calls. FIFO: waiters are released in the
 * order they arrived.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new RangeError(`Semaphore size must be a positive integer, got ${max}`);
    }
  }

  /** Number of permits currently held. */
  get inFlight(): number {
    return this.active;
  }

  /** Number of callers waiting for a permit. */
  get pending(): number {
    return this.waiters.length;
  }

  acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  release(): void {
    if (this.active === 0) throw new Error('Semaphore.release called without a matching acquire');
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }

  /** Runs `fn` once a permit is available and releases the permit when it settles. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
