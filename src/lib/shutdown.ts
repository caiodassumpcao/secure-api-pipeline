import type { Logger } from 'pino';

type ProcessEvents = Pick<NodeJS.Process, 'on'>;

/** Repeats of the first signal within this window are treated as duplicates. */
export const REPEATED_SIGNAL_GRACE_MS = 1_000;

export interface GracefulShutdownOptions {
  /** Stops accepting work and releases resources (HTTP server, database pool). */
  readonly close: () => Promise<void>;
  readonly logger: Pick<Logger, 'info' | 'error' | 'fatal'>;
  /** Hard deadline after which the process exits with code 1. */
  readonly timeoutMs: number;
  readonly signals?: readonly NodeJS.Signals[];
  /** Injected for tests. */
  readonly exit?: (code: number) => void;
  /** Injected for tests. */
  readonly process?: ProcessEvents;
}

export interface GracefulShutdown {
  readonly shutdown: (reason: string, exitCode?: number) => Promise<void>;
}

/**
 * Closes the app on SIGINT/SIGTERM and on fatal process errors, then exits.
 * A second signal while shutting down (after a short grace window for duplicate
 * deliveries), or exceeding the deadline, forces exit 1.
 */
export function registerGracefulShutdown(options: GracefulShutdownOptions): GracefulShutdown {
  const {
    close,
    logger,
    timeoutMs,
    signals = ['SIGINT', 'SIGTERM'],
    exit = (code: number) => process.exit(code),
    process: events = process,
  } = options;

  let shuttingDown = false;

  async function shutdown(reason: string, exitCode = 0): Promise<void> {
    if (shuttingDown) {
      logger.error({ reason }, 'forced exit while shutting down');
      exit(1);
      return;
    }
    shuttingDown = true;
    logger.info({ reason }, 'shutting down');

    const deadline = setTimeout(() => {
      logger.error({ timeoutMs }, 'graceful shutdown timed out');
      exit(1);
    }, timeoutMs);
    deadline.unref();

    try {
      await close();
      logger.info('shutdown complete');
      exit(exitCode);
    } catch (err) {
      logger.error({ err }, 'shutdown failed');
      exit(1);
    } finally {
      clearTimeout(deadline);
    }
  }

  // `node --watch` (pnpm dev) forwards the terminal's Ctrl+C to the app, which
  // then receives the same SIGINT twice at once: only a repeat after the grace
  // window, or a different signal, forces the exit.
  let firstSignal: { signal: NodeJS.Signals; at: number } | undefined;
  for (const signal of signals) {
    events.on(signal, () => {
      const now = Date.now();
      if (firstSignal?.signal === signal && now - firstSignal.at < REPEATED_SIGNAL_GRACE_MS) {
        return;
      }
      firstSignal ??= { signal, at: now };
      void shutdown(signal);
    });
  }
  events.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    void shutdown('uncaughtException', 1);
  });
  events.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
  });

  return { shutdown };
}
