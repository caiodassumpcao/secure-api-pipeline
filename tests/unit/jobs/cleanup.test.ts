import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleCleanup, type CleanupReport } from '../../../src/jobs/cleanup.ts';
import { createLogger } from '../../../src/lib/logger.ts';
import { LogCapture } from '../../helpers/log-capture.ts';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const report: CleanupReport = { skipped: false, deleted: { rate_limits: 3 } };

describe('scheduleCleanup', () => {
  it('runs a minute after startup, then on every interval, until stopped', async () => {
    const cleanup = vi.fn(() => Promise.resolve(report));
    const logs = new LogCapture();
    const job = scheduleCleanup(cleanup, createLogger({ level: 'info' }, logs), 3_600_000);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_600_000); // the interval fires at 1 h
    expect(cleanup).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(cleanup).toHaveBeenCalledTimes(3);

    job.stop();
    await vi.advanceTimersByTimeAsync(10 * 3_600_000);
    expect(cleanup).toHaveBeenCalledTimes(3);
    expect(logs.entries[0]).toMatchObject({
      msg: 'expired rows cleaned up',
      deleted: { rate_limits: 3 },
    });
  });

  it('logs failures instead of crashing, and stays quiet when another instance ran', async () => {
    const logs = new LogCapture();
    const cleanup = vi
      .fn<() => Promise<CleanupReport>>()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue({ skipped: true, deleted: {} });
    const job = scheduleCleanup(cleanup, createLogger({ level: 'info' }, logs), 60_000);

    await vi.advanceTimersByTimeAsync(120_000);
    job.stop();

    expect(cleanup).toHaveBeenCalledTimes(3);
    expect(logs.entries.map((entry) => entry.msg)).toEqual(['cleanup failed']);
  });
});
