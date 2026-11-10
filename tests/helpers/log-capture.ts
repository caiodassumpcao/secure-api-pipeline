export type LogEntry = Record<string, unknown> & { level: string; msg?: string };

/** In-memory pino destination: writes are synchronous, so assertions see every line. */
export class LogCapture {
  readonly lines: string[] = [];

  write(line: string): void {
    this.lines.push(line);
  }

  get text(): string {
    return this.lines.join('');
  }

  get entries(): LogEntry[] {
    return this.lines.map((line) => JSON.parse(line) as LogEntry);
  }
}
