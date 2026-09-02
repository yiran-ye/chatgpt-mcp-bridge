import { appendFile } from 'node:fs/promises';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
export class AuditLogger {
  constructor(private readonly transport: 'http' | 'stdio', private readonly level: LogLevel = 'info', private readonly auditFile?: string) {}
  async event(tool: string, decision: 'allow' | 'deny', durationMs: number, bytes: number, errorCategory?: string, relativePath?: string): Promise<void> {
    const record = { timestamp: new Date().toISOString(), transport: this.transport, tool, ...(relativePath ? { path: relativePath } : {}), decision, durationMs, bytes, ...(errorCategory ? { errorCategory } : {}) };
    if (this.level === 'debug') process.stderr.write(`${JSON.stringify(record)}\n`);
    if (this.auditFile) await appendFile(this.auditFile, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}
