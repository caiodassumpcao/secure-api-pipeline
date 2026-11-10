import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerGracefulShutdown, REPEATED_SIGNAL_GRACE_MS } from '../../../src/lib/shutdown.ts';

function setup(close: () => Promise<void> = () => Promise.resolve(), timeoutMs = 1_000) {
  const events = new EventEmitter();
  const exit = vi.fn<(code: number) => void>();
  const logger = { info: vi.fn(), error: vi.fn(), fatal: vi.fn() };
  const closeSpy = vi.fn(close);
  const handle = registerGracefulShutdown({
    close: closeSpy,
    logger,
    timeoutMs,
    exit,
    process: events as unknown as Pick<NodeJS.Process, 'on'>,
  });
  return { events, exit, logger, close: closeSpy, handle };
}

/** Lets the async shutdown sequence run to completion. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('registerGracefulShutdown', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['SIGTERM', 'SIGINT'] as const)('closes the app and exits 0 on %s', async (signal) => {
    const { events, exit, close, logger } = setup();

    events.emit(signal);
    await flush();

    expect(close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(logger.info).toHaveBeenCalledWith({ reason: signal }, 'shutting down');
  });

  it('exits 1 when closing fails', async () => {
    const failure = new Error('pool end failed');
    const { events, exit, logger } = setup(() => Promise.reject(failure));

    events.emit('SIGTERM');
    await flush();

    expect(logger.error).toHaveBeenCalledWith({ err: failure }, 'shutdown failed');
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('forces exit 1 when closing exceeds the deadline', async () => {
    vi.useFakeTimers();
    const { events, exit, logger } = setup(() => new Promise(() => undefined));

    events.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(logger.error).toHaveBeenCalledWith({ timeoutMs: 1_000 }, 'graceful shutdown timed out');
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('forces exit 1 on a second signal while shutting down', async () => {
    const { events, exit, close } = setup(() => new Promise(() => undefined));

    events.emit('SIGTERM');
    events.emit('SIGINT');
    await flush();

    expect(close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('ignores a duplicate delivery of the same signal (node --watch forwards Ctrl+C)', async () => {
    const { events, exit, close, logger } = setup();

    events.emit('SIGINT');
    events.emit('SIGINT');
    await flush();

    expect(close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('forces exit 1 when the same signal is repeated after the grace window', async () => {
    vi.useFakeTimers();
    const { events, exit } = setup(() => new Promise(() => undefined), 10_000);

    events.emit('SIGINT');
    await vi.advanceTimersByTimeAsync(REPEATED_SIGNAL_GRACE_MS + 1);
    events.emit('SIGINT');

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('logs and exits 1 on an uncaught exception', async () => {
    const { events, exit, logger, close } = setup();
    const failure = new Error('bug');

    events.emit('uncaughtException', failure);
    await flush();

    expect(logger.fatal).toHaveBeenCalledWith({ err: failure }, 'uncaught exception');
    expect(close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('logs and exits 1 on an unhandled rejection', async () => {
    const { events, exit, logger } = setup();
    const reason = new Error('rejected');

    events.emit('unhandledRejection', reason);
    await flush();

    expect(logger.fatal).toHaveBeenCalledWith({ err: reason }, 'unhandled promise rejection');
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('can be triggered programmatically with an exit code', async () => {
    const { handle, exit, close } = setup();

    await handle.shutdown('startup failure', 1);

    expect(close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
