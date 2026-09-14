import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { createFixture, type GitFixture } from '../helpers/git-fixture.js';
import { WorkspaceContext } from '../../src/workspace/workspace-context.js';
import { createMcpServer } from '../../src/server/create-server.js';
import { startHttpServer } from '../../src/transports/http-server.js';
import { downloadAttachment } from '../../src/attachment/download.js';
import type * as DownloadModule from '../../src/attachment/download.js';
import { MutationCoordinator } from '../../src/security/mutation-coordinator.js';
import { AuditLogger } from '../../src/security/audit-logger.js';
import { AttachmentService } from '../../src/workspace/attachment-service.js';

vi.mock('../../src/attachment/download.js', async importOriginal => ({
  ...await importOriginal<typeof DownloadModule>(), downloadAttachment: vi.fn(),
}));

const file = { download_url: 'https://files.example.org/private?signature=NEVER-LOG-THIS', file_id: 'file-example' };
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFOsAAAAASUVORK5CYII=', 'base64');
function byteResponse(): IncomingMessage { return Object.assign(Readable.from([bytes]), { headers: { 'content-length': String(bytes.length) }, statusCode: 200 }) as IncomingMessage; }

describe('附件 MCP 协议与生命周期', () => {
  let fixture: GitFixture; let workspace: WorkspaceContext; let coordinator: MutationCoordinator;
  beforeEach(async () => {
    fixture = await createFixture(); workspace = await WorkspaceContext.create(fixture.root); coordinator = new MutationCoordinator();
    vi.mocked(downloadAttachment).mockReset().mockImplementation(() => Promise.resolve(byteResponse()));
  });
  afterEach(async () => { vi.restoreAllMocks(); await coordinator.run(() => Promise.resolve()); await fixture.cleanup(); });

  async function connected(access: 'read-only' | 'workspace-write' = 'workspace-write', logger?: AuditLogger) {
    const server = createMcpServer(workspace, logger, { access, mutationCoordinator: coordinator }); const client = new Client({ name: 'attachment-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport as unknown as Parameters<typeof server.connect>[0]); await client.connect(clientTransport as unknown as Parameters<typeof client.connect>[0]);
    return { client, close: async () => { await client.close(); await server.close(); } };
  }

  it('tools/list 暴露官方四字段文件 schema、元数据和准确注解', async () => {
    const session = await connected();
    try {
      const tool = (await session.client.listTools()).tools.find(item => item.name === 'save_attachment');
      expect(tool?._meta).toEqual({ 'openai/fileParams': ['file'] });
      expect(tool?.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
      expect(tool?.inputSchema).toMatchObject({ required: ['file', 'path'], additionalProperties: false, properties: { file: {
        type: 'object', properties: { download_url: { type: 'string' }, file_id: { type: 'string' }, mime_type: { type: 'string' }, file_name: { type: 'string' } },
        required: ['download_url', 'file_id'], additionalProperties: false,
      } } });
      expect(tool?.outputSchema).toMatchObject({ properties: { data: { properties: { path: { type: 'string' }, bytes: { type: 'integer' }, sha256: { type: 'string' } }, required: ['path', 'bytes', 'sha256'] } } });
      const info = await session.client.callTool({ name: 'workspace_info', arguments: {} });
      expect(info.structuredContent).toMatchObject({ data: { security: { access: 'workspace-write', networkDisabledForTools: false, localToolsReadOnly: false } } });
    } finally { await session.close(); }
  });

  it('只读模式不注册或执行附件工具', async () => {
    const session = await connected('read-only');
    try {
      expect((await session.client.listTools()).tools.some(item => item.name === 'save_attachment')).toBe(false);
      expect((await session.client.callTool({ name: 'save_attachment', arguments: { file, path: 'a.png' } })).isError).toBe(true);
      expect(downloadAttachment).not.toHaveBeenCalled();
    } finally { await session.close(); }
  });

  it('文件保存响应包含路径、真实大小和哈希，日志不包含 URL/文件标识/正文', async () => {
    const auditPath = path.join(fixture.root, 'audit.jsonl'); const session = await connected('workspace-write', new AuditLogger('stdio', 'info', auditPath));
    try {
      const result = await session.client.callTool({ name: 'save_attachment', arguments: { file, path: 'assets/生成.png' } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ data: { path: 'assets/生成.png', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } });
      expect(await readFile(path.join(fixture.root, 'assets/生成.png'))).toEqual(bytes);
      const conflict = await session.client.callTool({ name: 'save_attachment', arguments: { file, path: 'assets/生成.png' } });
      expect(conflict.isError).toBe(true); expect(JSON.stringify(conflict)).toContain('FILE_CONFLICT');
      const audit = await readFile(auditPath, 'utf8'); expect(audit).toContain('save_attachment'); expect(audit).toContain('FILE_CONFLICT');
      for (const secret of [file.download_url, file.file_id, fixture.root, bytes.toString('base64')]) expect(audit).not.toContain(secret);
    } finally { await session.close(); }
  });

  it('拒绝未知字段、缺少文件标识与 sandbox 地址', async () => {
    const session = await connected();
    try {
      for (const args of [{ file, path: 'a.png', overwrite: true }, { file: { download_url: file.download_url }, path: 'a.png' }, { file: { ...file, download_url: 'sandbox:/mnt/data/a.png' }, path: 'a.png' }]) {
        expect((await session.client.callTool({ name: 'save_attachment', arguments: args })).isError).toBe(true);
      }
      expect(downloadAttachment).not.toHaveBeenCalled();
    } finally { await session.close(); }
  });

  it('服务返回不符合附件输出 schema 的结果时拒绝发布成功', async () => {
    vi.spyOn(AttachmentService.prototype, 'save').mockResolvedValueOnce({ path: 'x.png', bytes: -1, sha256: 'bad' });
    const session = await connected();
    try {
      const result = await session.client.callTool({ name: 'save_attachment', arguments: { file, path: 'x.png' } });
      expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain('INTERNAL_ERROR');
    } finally { await session.close(); }
  });

  it('真实 HTTP MCP 请求保存附件，正文通过下载流传递', async () => {
    const token = 'a'.repeat(32); const running = await startHttpServer(workspace, { host: '127.0.0.1', port: 0, mcpPath: '/mcp', allowPublicBind: false, authToken: token }, undefined, { access: 'workspace-write', mutationCoordinator: coordinator });
    const client = new Client({ name: 'attachment-http', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(running.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }) as unknown as Parameters<typeof client.connect>[0]);
      expect((await client.callTool({ name: 'save_attachment', arguments: { file, path: 'http.png' } })).isError).not.toBe(true);
      expect(await readFile(path.join(fixture.root, 'http.png'))).toEqual(bytes);
      expect((await client.listTools()).tools.find(tool => tool.name === 'save_attachment')?._meta).toEqual({ 'openai/fileParams': ['file'] });
    } finally { await client.close(); await running.close(); }
  });

  it.each(['cancel', 'deadline', 'shutdown'] as const)('HTTP %s 中止附件下载并清理临时文件', async cause => {
    const stream = new Readable({ read() { this.push(Buffer.from('partial')); this._read = () => undefined; } });
    vi.mocked(downloadAttachment).mockResolvedValueOnce(Object.assign(stream, { headers: {} }) as IncomingMessage);
    const token = 'b'.repeat(32); const running = await startHttpServer(workspace, { host: '127.0.0.1', port: 0, mcpPath: '/mcp', allowPublicBind: false, authToken: token, requestTimeoutMs: cause === 'deadline' ? 200 : 5000 }, undefined, { access: 'workspace-write', mutationCoordinator: coordinator });
    const client = new Client({ name: 'attachment-abort', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(running.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }) as unknown as Parameters<typeof client.connect>[0]);
      const controller = new AbortController();
      const pending = client.callTool({ name: 'save_attachment', arguments: { file, path: 'cancelled.png' } }, undefined, { signal: controller.signal });
      const rejected = expect(pending).rejects.toThrow();
      await vi.waitFor(() => expect(stream.readableDidRead).toBe(true));
      if (cause === 'cancel') controller.abort();
      if (cause === 'shutdown') await running.close();
      await rejected;
      await vi.waitFor(() => expect(stream.destroyed).toBe(true)); await coordinator.run(() => Promise.resolve());
      expect((await readdir(fixture.root)).some(name => name.endsWith('.tmp') || name === 'cancelled.png')).toBe(false);
    } finally { await client.close(); await running.close(); }
  });

  it('stdio 子进程公布附件元数据并拒绝内网下载请求', async () => {
    const client = new Client({ name: 'attachment-stdio', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/cli.ts', 'serve', '--workspace', fixture.root, '--transport', 'stdio', '--access', 'workspace-write'], stderr: 'pipe' });
    try {
      await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
      expect((await client.listTools()).tools.find(tool => tool.name === 'save_attachment')?._meta).toEqual({ 'openai/fileParams': ['file'] });
      const result = await client.callTool({ name: 'save_attachment', arguments: { file: { ...file, download_url: 'https://127.0.0.1/image.png' }, path: 'stdio.png' } });
      expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain('DOWNLOAD_BLOCKED');
      await expect(readFile(path.join(fixture.root, 'stdio.png'))).rejects.toThrow();
    } finally { await client.close(); }
  });
});
