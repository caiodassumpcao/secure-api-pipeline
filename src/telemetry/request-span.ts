import { trace, type Attributes } from '@opentelemetry/api';

/**
 * Adds attributes to the span of the current request. User and workspace ids
 * are opaque but personal data (threat model): they go on spans, which have a
 * short retention, never on metric labels. Never emails or names.
 */
export function annotateRequestSpan(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes);
}
