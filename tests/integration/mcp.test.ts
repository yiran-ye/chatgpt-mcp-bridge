import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFixture, type GitFixture } from '../helpers/git-fixture.js';
import { WorkspaceContext } from '../../src/workspace/workspace-context.js';
import { createMcpServer } from '../../src/server/create-server.js';
import { startHttpServer } from '../../src/transports/http-server.js';
import { PACKAGE_VERSION } from '../../src/shared/version.js';
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
    for (const [access, count] of [['workspace-write', 11], ['command-exec', 12]] as const) {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); const server = createMcpServer(workspace, undefined, { access, ...(access === 'command-exec' ? { commandConfig } : {}) }); const client = new Client({ name: 'write-test', version: '1' });
      await server.connect(serverTransport as unknown as Parameters<typeof server.connect>[0]); await client.connect(clientTransport as unknown as Parameters<typeof client.connect>[0]);
      const tools = (await client.listTools()).tools; expect(tools).toHaveLength(count); expect(tools.find(tool => tool.name === 'apply_patch')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
      if (access === 'command-exec') expect(tools.find(tool => tool.name === 'run_command')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
      await client.close(); await server.close();
    }
  });
  it('health 不泄露 workspace', async () => { const running = await startHttpServer(workspace, { host: '127.0.0.1', port: 0, mcpPath: '/mcp', allowPublicBind: false }); try { const response = await fetch(running.url.replace('/mcp', '/health')); const text = await response.text(); expect(response.status).toBe(200); expect(text).not.toContain(fixture.root); expect(text).toBe('{"status":"ok"}'); } finally { await running.close(); } });
  it('public bind 无 token 拒绝启动', async () => expect(startHttpServer(workspace, { host: '0.0.0.0', port: 0, mcpPath: '/mcp', allowPublicBind: true })).rejects.toMatchObject({ code: 'UNAUTHORIZED' }));
  it('HTTP 写模式要求 loopback 和强 Token', async () => {
    await expect(startHttpServer(workspace, { host: '127.0.0.1', port: 0, mcpPath: '/mcp', allowPublicBind: false }, undefined, { access: 'workspace-write' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(startHttpServer(workspace, { host: '0.0.0.0', port: 0, mcpPath: '/mcp', allowPublicBind: true, authToken: 'x'.repeat(32) }, undefined, { access: 'workspace-write' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
  it('HTTP Origin 和 Bearer 生效', async () => { const running = await startHttpServer(workspace, { host: '127.0.0.1', port: 0, mcpPath: '/mcp', allowPublicBind: false, authToken: 'abcdefghijklmnop' }); try { expect((await fetch(running.url, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' })).status).toBe(403); expect((await fetch(running.url, { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: '{}' })).status).toBe(401); } finally { await running.close(); } });
  it('stdio transport 可以初始化', async () => { const client = new Client({ name: 'stdio-test', version: '1' }); const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/cli.ts', 'serve', '--workspace', fixture.root, '--transport', 'stdio'], stderr: 'pipe' }); await client.connect(transport as unknown as Parameters<typeof client.connect>[0]); expect((await client.listTools()).tools).toHaveLength(10); await client.close(); });
});
