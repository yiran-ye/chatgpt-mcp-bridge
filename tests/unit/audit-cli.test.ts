import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditLogger } from '../../src/security/audit-logger.js';
import { parseArgs } from '../../src/cli.js';

describe('日志与 CLI', () => {
  it('日志不写正文、Token、绝对 workspace', async () => { const directory = await mkdtemp(path.join(tmpdir(), 'audit-test-')); const file = path.join(directory, 'audit.jsonl'); try { const logger = new AuditLogger('http', 'info', file); await logger.event('read_file', 'allow', 3, 20, undefined, 'src/a.ts'); const content = await readFile(file, 'utf8'); expect(content).not.toContain('SECRET-CONTENT'); expect(content).not.toContain('TOKEN'); expect(content).not.toContain('/Users/'); expect(content).toContain('src/a.ts'); } finally { await rm(directory, { recursive: true, force: true }); } });
  it('CLI 默认只监听 127.0.0.1:8765/mcp', () => expect(parseArgs(['serve', '.'])).toMatchObject({ host: '127.0.0.1', port: 8765, mcpPath: '/mcp', transport: 'http' }));
  it('CLI 兼容 pnpm 传入的 -- 分隔符', () => expect(parseArgs(['--', 'serve', '.'])).toMatchObject({ host: '127.0.0.1', port: 8765 }));
  it('CLI 拒绝未知参数', () => expect(() => parseArgs(['serve', '.', '--run-command', 'id'])).toThrow());
});
