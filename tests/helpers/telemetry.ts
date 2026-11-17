import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';

/** Unregisters the process-wide OpenTelemetry providers, so each test starts clean. */
export function resetOpenTelemetry(): void {
  trace.disable();
  metrics.disable();
  logs.disable();
  propagation.disable();
  context.disable();
}

/** Keeps every exported span; unlike InMemorySpanExporter, survives shutdown. */
export class CollectingSpanExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = [];

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    this.spans.push(...spans);
    done({ code: ExportResultCode.SUCCESS });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
