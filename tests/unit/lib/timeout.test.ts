import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimeoutError, withTimeout } from '../../../src/lib/timeout.ts';

describe('withTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the value of a promise that settles in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50)).resolves.toBe('ok');
  });

  it('propagates the rejection of a promise that settles in time', async () => {
    const failure = new Error('boom');
    await expect(withTimeout(Promise.reject(failure), 50)).rejects.toBe(failure);
  });

  it('rejects with TimeoutError when the promise is too slow', async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise(() => undefined), 1_000);
    const assertion = expect(pending).rejects.toThrow(new TimeoutError(1_000).message);

    await vi.advanceTimersByTimeAsync(1_000);

    await assertion;
    await expect(pending).rejects.toBeInstanceOf(TimeoutError);
  });

  it('clears its timer once the promise settles', async () => {
    vi.useFakeTimers();

    await withTimeout(Promise.resolve(1), 1_000);

    expect(vi.getTimerCount()).toBe(0);
  });
});
