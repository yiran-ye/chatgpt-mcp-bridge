import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFixture, type GitFixture } from '../helpers/git-fixture.js';
import { WorkspaceContext } from '../../src/workspace/workspace-context.js';
import { createMcpServer } from '../../src/server/create-server.js';
import { startHttpServer } from '../../src/transports/http-server.js';
import { PACKAGE_VERSION } from '../../src/shared/version.js';
import { AuditLogger } from '../../src/security/audit-logger.js';
import packageJson from '../../package.json' with { type: 'json' };

const expectedTools = ['change_context', 'workspace_info', 'workspace_instructions', 'git_status', 'git_changed_files', 'git_diff', 'git_compare', 'read_file', 'search_workspace', 'list_directory'];
const commandConfig = { version: 1 as const, commands: { node: { description: 'Node 版本', executable: process.execPath, fixedArgs: ['--version'], allowAdditionalArgs: false, forwardEnv: [], timeoutMs: 5000, maxOutputBytes: 4096 } } };

describe('MCP 协议集成', () => {
  let fixture: GitFixture; let workspace: WorkspaceContext;
  beforeAll(async () => { fixture = await createFixture(); workspace = await WorkspaceContext.create(fixture.root); }); afterAll(async () => fixture.cleanup());
  it('MCP 版本与 package.json 一致', () => { expect(PACKAGE_VERSION).toBe(packageJson.version); });
  it('initialize、tools/list、tools/call 成功且工具只读', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); const server = createMcpServer(workspace); const client = new Client({ name: 'test', version: '1' });
    await server.connect(serverTransport as unknown as Parameters<typeof server.connect>[0]); await client.connect(clientTransport as unknown as Parameters<typeof client.connect>[0]);
    const listed = await client.listTools(); expect(listed.tools.map(tool => tool.name).sort()).toEqual([...expectedTools].sort());
    for (const tool of listed.tools) expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(listed.tools.some(tool => /write|delete|shell|exec|command/iu.test(tool.name))).toBe(false);
    const called = await client.callTool({ name: 'change_context', arguments: {} }); expect(called.isError).not.toBe(true); const contextText = JSON.stringify(called.structuredContent); expect(contextText).toContain('workspaceName'); expect(contextText).toContain('stagedCount'); expect(contextText).toContain('untrackedCount');
    await client.close(); await server.close();
  });
  it('HTTP Streamable transport 初始化和调用成功', async () => {
    const running = await startHttpServer(workspace, { host: '127.0.0.1', port: 0, mcpPath: '/mcp', allowPublicBind: false });
    try { const client = new Client({ name: 'http-test', version: '1' }); await client.connect(new StreamableHTTPClientTransport(new URL(running.url)) as unknown as Parameters<typeof client.connect>[0]); expect((await client.listTools()).tools).toHaveLength(10); expect((await client.callTool({ name: 'git_status', arguments: {} })).isError).not.toBe(true); await client.close(); } finally { await running.close(); }
  });
  it('按访问模式注册写入和命令工具并正确标注', async () => {
    for (const [access, count] of [['workspace-write', 11], ['command-exec', 12], ['full-access', 12]] as const) {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); const server = createMcpServer(workspace, undefined, { access, ...(access === 'command-exec' ? { commandConfig } : {}) }); const client = new Client({ name: 'write-test', version: '1' });
      await server.connect(serverTransport as unknown as Parameters<typeof server.connect>[0]); await client.connect(clientTransport as unknown as Parameters<typeof client.connect>[0]);
      const tools = (await client.listTools()).tools; expect(tools).toHaveLength(count); expect(tools.find(tool => tool.name === 'apply_patch')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
      if (access === 'command-exec' || access === 'full-access') expect(tools.find(tool => tool.name === 'run_command')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
      if (access === 'full-access') {
        const called = await client.callTool({ name: 'run_command', arguments: { executable: path.basename(process.execPath), args: ['--version'] } }); expect(called.isError).not.toBe(true);
        expect((await client.callTool({ name: 'run_command', arguments: { commandId: 'node' } })).isError).toBe(true);
        expect((await client.callTool({ name: 'run_command', arguments: { executable: path.basename(process.execPath), surprise: true } })).isError).toBe(true);
        const info = await client.callTool({ name: 'workspace_info', arguments: {} }); expect(info.structuredContent).toMatchObject({ data: { security: { access: 'full-access', commandPolicy: 'unrestricted', networkDisabledForTools: false } } });
      }
      await client.close(); await server.close();
    }
  });
  it('full-access 拒绝同时传入命令白名单配置', () => expect(() => createMcpServer(workspace, undefined, { access: 'full-access', commandConfig })).toThrow(/full-access 不使用命令配置/u));
  it('full-access 审计日志不记录 executable 或参数正文', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'full-access-audit-')); const auditFile = path.join(directory, 'audit.jsonl'); const secretArg = 'DO-NOT-AUDIT-FULL-ACCESS-ARG';
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); const server = createMcpServer(workspace, new AuditLogger('stdio', 'info', auditFile), { access: 'full-access' }); const client = new Client({ name: 'audit-test', version: '1' });
    try {
      await server.connect(serverTransport as unknown as Parameters<typeof server.connect>[0]); await client.connect(clientTransport as unknown as Parameters<typeof client.connect>[0]);
      expect((await client.callTool({ name: 'run_command', arguments: { executable: path.basename(process.execPath), args: ['-e', 'process.stdout.write(process.argv[1] ?? "")', secretArg] } })).isError).not.toBe(true);
      const audit = await readFile(auditFile, 'utf8'); expect(audit).toContain('run_command'); expect(audit).not.toContain(path.basename(process.execPath)); expect(audit).not.toContain(secretArg);
    } finally { await client.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it('health 不泄露 workspace', async () => { const running = await startHttpServer(workspace, { host: '127.0.0.1', port: 0, mcpPath: '/mcp', allowPublicBind: false }); try { const response = await fetch(running.url.replace('/mcp', '/health')); const text = await response.text(); expect(response.status).toBe(200); expect(text).not.toContain(fixture.root); expect(text).toBe('{"status":"ok"}'); } finally { await running.close(); } });
  it('public bind 无 token 拒绝启动', async () => expect(startHttpServer(workspace, { host: '0.0.0.0', port: 0, mcpPath: '/mcp', allowPublicBind: true })).rejects.toMatchObject({ code: 'UNAUTHORIZED' }));
  it('HTTP 写模式要求 loopback 和强 Token', async () => {
    await expect(startHttpServer(workspace, { host: '127.0.0.1', port: 0, mcpPath: '/mcp', allowPublicBind: false }, undefined, { access: 'workspace-write' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(startHttpServer(workspace, { host: '0.0.0.0', port: 0, mcpPath: '/mcp', allowPublicBind: true, authToken: 'x'.repeat(32) }, undefined, { access: 'workspace-write' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(startHttpServer(workspace, { host: '127.0.0.1', port: 0, mcpPath: '/mcp', allowPublicBind: false }, undefined, { access: 'full-access' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(startHttpServer(workspace, { host: '0.0.0.0', port: 0, mcpPath: '/mcp', allowPublicBind: true, authToken: 'x'.repeat(32) }, undefined, { access: 'full-access' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
  it('HTTP 客户端取消后终止 full-access 命令并释放互斥队列', async () => {
    const token = 'c'.repeat(32); const marker = 'http-client-cancelled-marker'; const running = await startHttpServer(workspace, { host: '127.0.0.1', port: 0, mcpPath: '/mcp', allowPublicBind: false, authToken: token, requestTimeoutMs: 2000, maxConcurrent: 2 }, undefined, { access: 'full-access' }); const client = new Client({ name: 'http-cancel-test', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(running.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }) as unknown as Parameters<typeof client.connect>[0]);
      const pending = client.callTool({ name: 'run_command', arguments: { executable: path.basename(process.execPath), args: ['-e', `setTimeout(() => require('node:fs').writeFileSync('${marker}', 'unexpected'), 500)`], timeoutMs: 1000 } }, undefined, { timeout: 100 });
      await expect(pending).rejects.toThrow(/timed out/iu); await new Promise(resolve => setTimeout(resolve, 600)); await expect(readFile(path.join(fixture.root, marker))).rejects.toThrow();
      expect((await client.callTool({ name: 'run_command', arguments: { executable: path.basename(process.execPath), args: ['-e', 'process.stdout.write("released")'] } })).isError).not.toBe(true);
    } finally { await client.close(); await running.close(); }
  });
  it('HTTP 服务端 deadline 会终止仍在运行的 full-access 命令', async () => {
    const token = 'd'.repeat(32); const marker = 'http-deadline-marker'; const running = await startHttpServer(workspace, { host: '127.0.0.1', port: 0, mcpPath: '/mcp', allowPublicBind: false, authToken: token, requestTimeoutMs: 150 }, undefined, { access: 'full-access' }); const client = new Client({ name: 'http-deadline-test', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(running.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }) as unknown as Parameters<typeof client.connect>[0]);
      const pending = client.callTool({ name: 'run_command', arguments: { executable: path.basename(process.execPath), args: ['-e', `setTimeout(() => require('node:fs').writeFileSync('${marker}', 'unexpected'), 500)`], timeoutMs: 1000 } }, undefined, { timeout: 2000 });
      await expect(pending).rejects.toThrow(); await new Promise(resolve => setTimeout(resolve, 600)); await expect(readFile(path.join(fixture.root, marker))).rejects.toThrow();
    } finally { await client.close(); await running.close(); }
  });
  it('HTTP Origin 和 Bearer 生效', async () => { const running = await startHttpServer(workspace, { host: '127.0.0.1', port: 0, mcpPath: '/mcp', allowPublicBind: false, authToken: 'abcdefghijklmnop' }); try { expect((await fetch(running.url, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' })).status).toBe(403); expect((await fetch(running.url, { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: '{}' })).status).toBe(401); } finally { await running.close(); } });
  it('stdio transport 可以初始化', async () => { const client = new Client({ name: 'stdio-test', version: '1' }); const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/cli.ts', 'serve', '--workspace', fixture.root, '--transport', 'stdio'], stderr: 'pipe' }); await client.connect(transport as unknown as Parameters<typeof client.connect>[0]); expect((await client.listTools()).tools).toHaveLength(10); await client.close(); });
  it('stdio full-access 无需配置即可初始化和执行命令', async () => { const client = new Client({ name: 'stdio-full-access-test', version: '1' }); const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/cli.ts', 'serve', '--workspace', fixture.root, '--transport', 'stdio', '--access', 'full-access'], stderr: 'pipe' }); await client.connect(transport as unknown as Parameters<typeof client.connect>[0]); expect((await client.listTools()).tools).toHaveLength(12); expect((await client.callTool({ name: 'run_command', arguments: { executable: path.basename(process.execPath), args: ['--version'] } })).isError).not.toBe(true); await client.close(); });
});
