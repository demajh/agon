import { describe, expect, it } from 'vitest';
import { Semaphore } from './limiter.js';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('Semaphore', () => {
  it('never lets more than `max` tasks run at once and releases waiters in order', async () => {
    const limiter = new Semaphore(2);
    let inFlight = 0;
    let maxInFlight = 0;
    const order: number[] = [];
    const tasks = Array.from({ length: 6 }, (_, i) =>
      limiter.run(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        order.push(i);
        await tick();
        inFlight--;
        return i;
      }),
    );
    expect(limiter.inFlight).toBe(2);
    expect(limiter.pending).toBe(4);
    expect(await Promise.all(tasks)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(maxInFlight).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
    expect(limiter.inFlight).toBe(0);
    expect(limiter.pending).toBe(0);
  });

  it('releases the permit when the task throws', async () => {
    const limiter = new Semaphore(1);
    await expect(
      limiter.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(limiter.inFlight).toBe(0);
    await expect(limiter.run(async () => 'next')).resolves.toBe('next');
  });

  it('rejects invalid sizes and unbalanced releases', () => {
    expect(() => new Semaphore(0)).toThrow(RangeError);
    expect(() => new Semaphore(1.5)).toThrow(RangeError);
    expect(() => new Semaphore(1).release()).toThrow(/without a matching acquire/);
  });
});
