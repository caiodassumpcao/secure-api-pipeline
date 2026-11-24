import { createServer, type Server } from 'node:http';

type AnyValue = Record<string, unknown>;

interface KeyValue {
  key: string;
  value: AnyValue;
}

export interface ReceivedSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly name: string;
  readonly kind: number;
  readonly scope: string;
  readonly attributes: Record<string, unknown>;
  readonly events: { name: string; attributes: Record<string, unknown> }[];
  readonly status: { code?: number; message?: string } | undefined;
}

export interface ReceivedLog {
  readonly body: unknown;
  readonly severityText: string | undefined;
  readonly traceId: string | undefined;
  readonly spanId: string | undefined;
  readonly attributes: Record<string, unknown>;
}

/** Ids and other OTLP scalars arrive as strings in the JSON encoding. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function scalar(value: AnyValue | undefined): unknown {
  if (value === undefined) return undefined;
  if ('stringValue' in value) return value.stringValue;
  if ('intValue' in value) return Number(value.intValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('boolValue' in value) return value.boolValue;
  if ('arrayValue' in value) {
    const values = (value.arrayValue as { values?: AnyValue[] }).values ?? [];
    return values.map(scalar);
  }
  if ('kvlistValue' in value) {
    return toRecord((value.kvlistValue as { values?: KeyValue[] }).values);
  }
  return value;
}

function toRecord(attributes: KeyValue[] | undefined): Record<string, unknown> {
  return Object.fromEntries((attributes ?? []).map(({ key, value }) => [key, scalar(value)]));
}

/** Env for an API process that exports everything, quickly, to `receiver`. */
export function exportingTo(receiver: Pick<OtlpReceiver, 'url'>): Record<string, string> {
  return {
    OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url,
    OTEL_TRACES_SAMPLER_ARG: '1',
    OTEL_BSP_SCHEDULE_DELAY: '100',
    OTEL_BLRP_SCHEDULE_DELAY: '100',
    OTEL_METRIC_EXPORT_INTERVAL: '500',
  };
}

/** Collects what an OTLP/HTTP JSON exporter sends, for assertions. */
export class OtlpReceiver {
  readonly url: string;
  /** Every request body as received, to search for leaked secrets. */
  readonly bodies: string[] = [];
  private readonly payloads = new Map<string, unknown[]>();
  private readonly server: Server;

  private constructor(server: Server, url: string) {
    this.server = server;
    this.url = url;
  }

  static async start(): Promise<OtlpReceiver> {
    const holder: { receiver?: OtlpReceiver } = {};
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        holder.receiver?.bodies.push(body);
        const list = holder.receiver?.payloads.get(request.url ?? '') ?? [];
        list.push(JSON.parse(body));
        holder.receiver?.payloads.set(request.url ?? '', list);
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (typeof address !== 'object' || address === null) throw new Error('no address');
    holder.receiver = new OtlpReceiver(server, `http://127.0.0.1:${address.port}`);
    return holder.receiver;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  spans(): ReceivedSpan[] {
    return (this.payloads.get('/v1/traces') ?? []).flatMap((payload) =>
      ((payload as { resourceSpans?: AnyValue[] }).resourceSpans ?? []).flatMap((resource) =>
        ((resource.scopeSpans as AnyValue[] | undefined) ?? []).flatMap((scopeSpans) =>
          ((scopeSpans.spans as AnyValue[] | undefined) ?? []).map((span) => ({
            traceId: text(span.traceId) ?? '',
            spanId: text(span.spanId) ?? '',
            parentSpanId: text(span.parentSpanId),
            name: String(span.name),
            kind: Number(span.kind),
            scope: String((scopeSpans.scope as { name?: string } | undefined)?.name),
            attributes: toRecord(span.attributes as KeyValue[] | undefined),
            events: ((span.events as AnyValue[] | undefined) ?? []).map((event) => ({
              name: String(event.name),
              attributes: toRecord(event.attributes as KeyValue[] | undefined),
            })),
            status: span.status as ReceivedSpan['status'],
          })),
        ),
      ),
    );
  }

  logs(): ReceivedLog[] {
    return (this.payloads.get('/v1/logs') ?? []).flatMap((payload) =>
      ((payload as { resourceLogs?: AnyValue[] }).resourceLogs ?? []).flatMap((resource) =>
        ((resource.scopeLogs as AnyValue[] | undefined) ?? []).flatMap((scopeLogs) =>
          ((scopeLogs.logRecords as AnyValue[] | undefined) ?? []).map((record) => ({
            body: scalar(record.body as AnyValue | undefined),
            severityText: record.severityText as string | undefined,
            traceId: text(record.traceId),
            spanId: text(record.spanId),
            attributes: toRecord(record.attributes as KeyValue[] | undefined),
          })),
        ),
      ),
    );
  }

  metricNames(): string[] {
    return (this.payloads.get('/v1/metrics') ?? []).flatMap((payload) =>
      ((payload as { resourceMetrics?: AnyValue[] }).resourceMetrics ?? []).flatMap((resource) =>
        ((resource.scopeMetrics as AnyValue[] | undefined) ?? []).flatMap((scope) =>
          ((scope.metrics as AnyValue[] | undefined) ?? []).map((metric) => String(metric.name)),
        ),
      ),
    );
  }

  /** Polls until `check` returns a value, or fails after `timeoutMs`. */
  async waitFor<T>(check: () => T | undefined, timeoutMs = 15_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = check();
      if (result !== undefined) return result;
      if (Date.now() > deadline) throw new Error('timed out waiting for telemetry');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
