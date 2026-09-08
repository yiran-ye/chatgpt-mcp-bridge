import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createFixture } from '../helpers/git-fixture.js';
import { echoSchema, httpUpstream } from '../helpers/upstream-server.js';
import { WorkspaceContext } from '../../src/workspace/workspace-context.js';
import { McpProxyRuntime } from '../../src/mcp/proxy-runtime.js';
import { createMcpServer } from '../../src/server/create-server.js';
import { startHttpServer } from '../../src/transports/http-server.js';
import { McpSchemaValidator } from '../../src/mcp/schema-validator.js';
import { AuditLogger } from '../../src/security/audit-logger.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const sourceRoot = fileURLToPath(new URL('../..', import.meta.url));
const loader = import.meta.resolve('tsx');
const fixtureScript = fileURLToPath(new URL('../helpers/stdio-upstream.ts', import.meta.url));
const token = 'proxy-test-token-'.repeat(3);

async function workspace(): Promise<WorkspaceContext> { const fixture = await createFixture(); cleanup.push(() => fixture.cleanup()); return await WorkspaceContext.create(fixture.root); }
function local(env: Record<string, string> = {}) { return { transport: 'stdio', command: path.basename(process.execPath), args: ['--import', loader, fixtureScript], env }; }
async function runtime(ws: WorkspaceContext, servers: Record<string, unknown>): Promise<McpProxyRuntime> { const proxy = await McpProxyRuntime.create(ws, { version: 1, mcpServers: servers }); cleanup.push(() => proxy.close()); return proxy; }
async function memory(ws: WorkspaceContext, proxy?: McpProxyRuntime, logger?: AuditLogger): Promise<Client> {
  const server = createMcpServer(ws, logger, proxy ? { mcpProxy: proxy } : undefined); const client = new Client({ name: 'proxy-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanup.push(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport as unknown as Parameters<typeof server.connect>[0]); await client.connect(clientTransport as unknown as Parameters<typeof client.connect>[0]);
  return client;
}
async function configure(ws: WorkspaceContext, servers: Record<string, unknown>): Promise<void> { await mkdir(path.join(ws.root, '.chatgpt-mcp-bridge'), { recursive: true }); await writeFile(path.join(ws.root, '.chatgpt-mcp-bridge/mcp.json'), JSON.stringify({ version: 1, mcpServers: servers })); }
async function cliClient(ws: WorkspaceContext, extra: string[] = []): Promise<{ client: Client; stderr(): string }> {
  const client = new Client({ name: 'proxy-cli-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', loader, path.join(sourceRoot, 'src/cli.ts'), 'serve', ws.root, '--transport', 'stdio', ...extra], stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  cleanup.push(() => client.close());
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]); return { client, stderr: () => stderr };
}
function gateway(serverId: string, toolName: string, args: Record<string, unknown> = {}) { return { name: 'mcp_call_tool', arguments: { serverId, toolName, arguments: args } }; }
async function directory(client: Client, serverId: string, cursor?: string) {
  const result = await client.callTool({ name: 'mcp_list_tools', arguments: { serverId, ...(cursor ? { cursor } : {}) } });
  expect(result.isError).not.toBe(true);
  return result.structuredContent as { serverId: string; tools: Tool[]; nextCursor?: string };
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

describe('项目 MCP 代理集成与安全边界', () => {
  it('固定网关保留上游原始 schema、结果和内置工具', async () => {
    const ws = await workspace(); const proxy = await runtime(ws, { local: local() });
    expect(proxy.summaries()).toMatchObject([{ id: 'local', status: 'ready', toolCount: 8 }]);
    const client = await memory(ws, proxy); const listed = await client.listTools();
    expect(listed.tools).toHaveLength(13);
    expect(listed.tools.find(tool => tool.name === 'mcp_call_tool')?.annotations?.readOnlyHint).toBe(false);
    const discovered = await directory(client, 'local');
    expect(discovered.tools.find(tool => tool.name === 'echo')?.inputSchema).toEqual(echoSchema);
    expect(discovered.tools.find(tool => tool.name === 'echo')?.annotations?.readOnlyHint).toBe(true);
    const result = await client.callTool(gateway('local', 'echo', { message: 'hello', option: 42 }));
    expect(result.structuredContent).toEqual({ message: 'hello', option: 42 });
    expect(result.content).toEqual([{ type: 'text', text: 'hello' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }, { type: 'audio', data: 'aGVsbG8=', mimeType: 'audio/wav' }]);
    expect((await client.callTool({ name: 'git_status', arguments: {} })).isError).not.toBe(true);
    expect((await client.callTool({ name: 'workspace_info', arguments: {} })).structuredContent).toMatchObject({ data: { mcp: { enabled: true, servers: [{ status: 'ready' }] }, security: { readOnly: false, localToolsReadOnly: true, workspaceContained: false, networkDisabledForTools: false } } });
  });

  it('无效参数不转发，RPC 错误脱敏，工具错误原样返回', async () => {
    const ws = await workspace(); const upstream = await httpUpstream(); cleanup.push(() => upstream.close());
    const proxy = await runtime(ws, { remote: { transport: 'http', url: upstream.url } }); const client = await memory(ws, proxy);
    expect(proxy.summaries()[0]?.status).toBe('ready');
    for (const args of [{ message: 42 }, { message: 'ok', executable: 'sh' }, {}]) expect((await client.callTool(gateway('remote', 'echo', args))).isError).toBe(true);
    for (const request of [
      gateway('missing', 'echo', { message: 'x' }), gateway('remote', 'unknown'),
      { name: 'mcp_call_tool', arguments: { serverId: 'remote', toolName: 'echo', arguments: [] } },
      { name: 'mcp_call_tool', arguments: { serverId: 'remote', toolName: 'echo', arguments: { message: 'x' }, url: upstream.url } },
      { name: 'mcp_remote__echo', arguments: { message: 'legacy alias' } },
    ]) expect((await client.callTool(request)).isError).toBe(true);
    expect((await client.callTool(gateway('remote', 'echo', { message: 'x'.repeat(1024 * 1024) }))).isError).toBe(true);
    expect(upstream.state.calls).toHaveLength(0);
    const failure = await client.callTool(gateway('remote', 'fail', {})); expect(failure).toMatchObject({ isError: true, content: [{ text: 'expected failure' }] });
    const rpcError = await client.callTool(gateway('remote', 'rpc_error', {})); expect(rpcError.isError).toBe(true); expect(JSON.stringify(rpcError)).not.toContain('UPSTREAM-PRIVATE-DETAIL');
    expect((await client.callTool(gateway('remote', 'bad_output', {}))).isError).toBe(true);
    expect((await client.callTool({ name: 'run_command', arguments: { executable: 'sh' } })).isError).toBe(true);
  });

  it('HTTP 上游认证使用显式请求头，不跟随重定向', async () => {
    const ws = await workspace(); const upstream = await httpUpstream({ token: 'upstream-private-token' }); cleanup.push(() => upstream.close());
    const proxy = await runtime(ws, { remote: { transport: 'http', url: upstream.url, headers: { Authorization: 'Bearer upstream-private-token' } } });
    expect(proxy.summaries()[0]?.status).toBe('ready');
    expect((await proxy.callTool('remote', 'echo', { message: 'authorized' })).structuredContent).toEqual({ message: 'authorized' });
    const target = await httpUpstream(); cleanup.push(() => target.close());
    const redirect = await httpUpstream({ redirect: target.url }); cleanup.push(() => redirect.close());
    const rejected = await runtime(ws, { redirect: { transport: 'http', url: redirect.url, headers: { Authorization: 'Bearer private' } } });
    expect(rejected.summaries()[0]?.status).toBe('error'); expect(target.state.requests).toBe(0);
  });

  it('隔离同名 schema 的 $id，并拒绝外部引用和非法 schema', async () => {
    const ws = await workspace(); const proxy = await runtime(ws, { good: local({ MCP_TEST_MODE: 'same-id' }), bad: local({ MCP_TEST_MODE: 'bad-schema' }), external: local({ MCP_TEST_MODE: 'remote-ref' }), missing: { transport: 'stdio', command: 'nonexistent-mcp-test-program' } });
    expect(proxy.summaries().map(server => [server.id, server.status])).toEqual([['good', 'ready'], ['bad', 'error'], ['external', 'error'], ['missing', 'error']]);
    await expect(proxy.callTool('good', 'different', { message: 'wrong shape' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await proxy.callTool('good', 'different', { count: 7 })).structuredContent).toEqual({ count: 7 });
    expect((await (await memory(ws, proxy)).callTool({ name: 'git_status', arguments: {} })).isError).not.toBe(true);
  });

  it('原始名称按服务隔离，目录分页拒绝伪造、跨服务和过期游标', async () => {
    const ws = await workspace(); const proxy = await runtime(ws, { names: local({ MCP_TEST_MODE: 'names' }), many: local({ MCP_TEST_MODE: 'many' }) });
    const client = await memory(ws, proxy);
    const names = await directory(client, 'names');
    for (const name of ['same.name', 'same_name', 'x'.repeat(100)]) {
      expect(names.tools.some(tool => tool.name === name)).toBe(true);
      expect((await client.callTool(gateway('names', name))).isError).not.toBe(true);
    }
    for (const serverId of ['names', 'many']) expect((await client.callTool(gateway(serverId, 'echo', { message: serverId }))).structuredContent).toEqual({ message: serverId });
    const first = await directory(client, 'many'); expect(first.tools).toHaveLength(100); expect(first.nextCursor).toBeTruthy();
    if (!first.nextCursor) throw new Error('Expected a paginated catalog');
    const second = await directory(client, 'many', first.nextCursor); expect(first.tools.length + second.tools.length).toBe(118); expect(second.nextCursor).toBeUndefined();
    for (const args of [{ serverId: 'many', cursor: first.nextCursor + 'tampered' }, { serverId: 'many', cursor: first.nextCursor + '.extra' }, { serverId: 'names', cursor: first.nextCursor }]) {
      expect((await client.callTool({ name: 'mcp_list_tools', arguments: args })).isError).toBe(true);
    }
    const changed = await memory(ws, await runtime(ws, { many: local() }));
    expect((await changed.callTool({ name: 'mcp_list_tools', arguments: { serverId: 'many', cursor: first.nextCursor } })).isError).toBe(true);
    const otherWorkspace = await workspace();
    const other = await memory(otherWorkspace, await runtime(otherWorkspace, { many: local({ MCP_TEST_MODE: 'many' }) }));
    expect((await other.callTool({ name: 'mcp_list_tools', arguments: { serverId: 'many', cursor: first.nextCursor } })).isError).toBe(true);
  });

  it('目录按完整返回字节数分页，单个过大定义明确报错', async () => {
    const ws = await workspace(); const proxy = await runtime(ws, { large: local({ MCP_TEST_MODE: 'large-catalog' }), oversized: local({ MCP_TEST_MODE: 'oversized-definition' }) });
    const client = await memory(ws, proxy); const names: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const result = await client.callTool({ name: 'mcp_list_tools', arguments: { serverId: 'large', ...(cursor ? { cursor } : {}) } });
      expect(result.isError).not.toBe(true); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1024 * 1024);
      const data = result.structuredContent as { tools: Tool[]; nextCursor?: string };
      names.push(...data.tools.map(tool => tool.name)); cursor = data.nextCursor; pages++;
      expect(pages).toBeLessThanOrEqual(3);
    } while (cursor);
    expect(pages).toBeGreaterThan(1); expect(names).toHaveLength(12); expect(new Set(names).size).toBe(12);
    const rejected = await client.callTool({ name: 'mcp_list_tools', arguments: { serverId: 'oversized' } });
    expect(rejected.isError).toBe(true); expect(JSON.stringify(rejected)).toContain('OUTPUT_LIMIT_EXCEEDED');
    expect((await client.callTool({ name: 'git_status', arguments: {} })).isError).not.toBe(true);
  });

  it('有配置即自动启动 stdio 上游，stdout 保持协议纯净并兼容旧开关', async () => {
    const ws = await workspace(); const marker = path.join(ws.root, 'started'); const secret = 'DO-NOT-LOG-UPSTREAM-SECRET';
    await configure(ws, { local: local({ MCP_TEST_START_MARKER: marker, MCP_TEST_STDERR_SECRET: secret }) });
    for (const extra of [[], ['--enable-mcp']]) {
      const enabled = await cliClient(ws, extra); expect((await enabled.client.listTools()).tools).toHaveLength(13);
      expect((await readFile(marker, 'utf8')).trim()).toMatch(/^\d+(?:\n\d+)*$/u); expect(enabled.stderr()).not.toContain(secret);
      expect((await enabled.client.callTool(gateway('local', 'echo', { message: 'automatic' }))).structuredContent).toEqual({ message: 'automatic' });
      await expect(enabled.client.callTool({ name: 'read_file', arguments: { path: '.chatgpt-mcp-bridge/mcp.json' } })).resolves.toMatchObject({ isError: true });
      await enabled.client.close();
    }
  });

  it('HTTP 上游自动连接，非法配置在启动任何上游前失败', async () => {
    const ws = await workspace(); const upstream = await httpUpstream(); cleanup.push(() => upstream.close());
    await configure(ws, { remote: { transport: 'http', url: upstream.url } });
    const first = await cliClient(ws); expect(upstream.state.requests).toBeGreaterThan(0);
    expect((await first.client.callTool(gateway('remote', 'echo', { message: 'automatic HTTP' }))).structuredContent).toEqual({ message: 'automatic HTTP' });
    await first.client.close();
    const marker = path.join(ws.root, 'must-not-start');
    for (const bad of [{ transport: 'stdio', command: 'node', cwd: 'missing-directory' }, { transport: 'stdio', command: './missing-program' }, { transport: 'stdio', command: 'node', cwd: '..' }, { transport: 'stdio', command: 'node', env: { KEY: '${env:MCP_MISSING_CONFIG_VARIABLE}' } }]) {
      await configure(ws, { good: local({ MCP_TEST_START_MARKER: marker }), bad });
      await expect(cliClient(ws)).rejects.toThrow();
      await expect(readFile(marker)).rejects.toThrow();
    }
    await writeFile(path.join(ws.root, '.chatgpt-mcp-bridge/mcp.json'), 'invalid JSON');
    await expect(cliClient(ws)).rejects.toThrow();
  });

  it('客户端缓存一次接口后，空配置、新服务及工具参数变化均无需刷新接口', async () => {
    const ws = await workspace(); const initial = await cliClient(ws);
    const cached = (await initial.client.listTools()).tools;
    expect(cached).toHaveLength(13);
    expect((await initial.client.callTool({ name: 'mcp_list_servers', arguments: {} })).structuredContent).toEqual({ enabled: false, servers: [] });
    expect((await initial.client.callTool(gateway('missing', 'echo'))).isError).toBe(true);
    await initial.client.close();
    const wrapper = cached.find(tool => tool.name === 'mcp_call_tool');
    if (!wrapper) throw new Error('Missing gateway');
    const validate = new McpSchemaValidator().getValidator(wrapper.inputSchema as JsonSchemaType);
    for (const servers of [{}, { local: local() }, { local: local({ MCP_TEST_MODE: 'changed' }) }, { renamed: local({ MCP_TEST_MODE: 'names' }) }, { failed: { transport: 'stdio', command: 'nonexistent-mcp-test-program' } }]) {
      await configure(ws, servers);
      const next = await cliClient(ws);
      const summary = (await next.client.callTool({ name: 'mcp_list_servers', arguments: {} })).structuredContent;
      expect(summary).toMatchObject({ enabled: Object.keys(servers).length > 0 });
      if ('local' in servers || 'renamed' in servers) {
        const serverId = 'local' in servers ? 'local' : 'renamed';
        const discovered = await directory(next.client, serverId);
        const echo = discovered.tools.find(tool => tool.name === 'echo');
        const args = echo?.inputSchema.required?.includes('count') ? { count: 9 } : { message: 'cached interface' };
        const request = gateway(serverId, 'echo', args);
        expect(validate(request.arguments).valid).toBe(true);
        expect((await next.client.callTool({ ...request, name: wrapper.name })).structuredContent).toEqual(args);
      }
      if ('failed' in servers) {
        expect(summary).toMatchObject({ servers: [{ status: 'error' }] });
        expect((await next.client.callTool({ name: 'mcp_list_tools', arguments: { serverId: 'failed' } })).isError).toBe(true);
      }
      expect((await next.client.listTools()).tools).toEqual(cached);
      await next.client.close();
    }
  }, 20_000);

  it('config/doctor 不启动进程或联网，且只输出脱敏摘要', async () => {
    const ws = await workspace(); const marker = path.join(ws.root, 'diagnostic-started'); const secret = 'MCP-DIAGNOSTIC-SECRET';
    const upstream = await httpUpstream(); cleanup.push(() => upstream.close());
    await configure(ws, { local: local({ MCP_TEST_START_MARKER: marker, KEY: secret }), remote: { transport: 'http', url: upstream.url, headers: { Authorization: `Bearer ${secret}` } } });
    for (const command of ['config', 'doctor']) {
      const { stdout } = await promisify(execFile)(process.execPath, ['--import', loader, path.join(sourceRoot, 'src/cli.ts'), command, ws.root, '--transport', 'stdio']);
      expect(JSON.parse(stdout)).toMatchObject({ mcp: { enabled: true, exists: true, servers: [{ id: 'local', transport: 'stdio' }, { id: 'remote', transport: 'http' }] } }); expect(stdout).not.toContain(secret);
    }
    await expect(readFile(marker)).rejects.toThrow(); expect(upstream.state.requests).toBe(0);
  });

  it('HTTP 代理要求强认证，并在启动上游前拒绝无认证配置', async () => {
    const ws = await workspace(); const marker = path.join(ws.root, 'unauthorized-started');
    const upstream = await httpUpstream(); cleanup.push(() => upstream.close());
    await configure(ws, { local: local({ MCP_TEST_START_MARKER: marker }), remote: { transport: 'http', url: upstream.url } });
    await expect(promisify(execFile)(process.execPath, ['--import', loader, path.join(sourceRoot, 'src/cli.ts'), 'serve', ws.root], { env: { ...process.env, CHATGPT_MCP_BRIDGE_TOKEN: 'short-valid-token' } })).rejects.toThrow(/UNAUTHORIZED/u);
    await expect(readFile(marker)).rejects.toThrow();
    expect(upstream.state.requests).toBe(0);
    for (const options of [{ host: '127.0.0.1' }, { host: '0.0.0.0', authToken: token }]) {
      const proxy = await runtime(ws, {});
      await expect(startHttpServer(ws, { ...options, port: 0, mcpPath: '/mcp', allowPublicBind: true }, undefined, { mcpProxy: proxy })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
  });

  it('HTTP 多次调用复用一个 stdio 进程，关闭时清理整个进程树', async () => {
    const ws = await workspace(); const marker = path.join(ws.root, 'shared-starts'); const childMarker = path.join(ws.root, 'child-pid');
    const proxy = await runtime(ws, { local: local({ MCP_TEST_START_MARKER: marker, MCP_TEST_CHILD_MARKER: childMarker }) });
    const running = await startHttpServer(ws, { host: '127.0.0.1', port: 0, mcpPath: '/mcp', allowPublicBind: false, authToken: token }, undefined, { mcpProxy: proxy }); cleanup.push(() => running.close());
    const client = new Client({ name: 'http-proxy-test', version: '1' }); cleanup.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }) as unknown as Parameters<typeof client.connect>[0]);
    for (let index = 0; index < 3; index++) expect((await client.callTool(gateway('local', 'echo', { message: `call-${index}` }))).isError).not.toBe(true);
    expect((await readFile(marker, 'utf8')).trim().split('\n')).toHaveLength(1);
    const parent = Number((await readFile(marker, 'utf8')).trim()); const child = Number(await readFile(childMarker, 'utf8'));
    await client.close(); await running.close();
    await vi.waitFor(() => { expect(alive(parent)).toBe(false); expect(alive(child)).toBe(false); }, { timeout: 3000 });
    expect(proxy.summaries()[0]?.status).toBe('closed');
  });

  it('只显式转发环境变量，参数不经 shell，审计不记录正文或密钥', async () => {
    const ws = await workspace(); vi.stubEnv('MCP_TEST_PRIVATE', 'hidden'); vi.stubEnv('MCP_TEST_SOURCE', 'explicit-secret');
    const definition = local({ MCP_TEST_ALLOWED: '${env:MCP_TEST_SOURCE}' }); definition.args.push('$(touch SHELL-INJECTION);');
    const proxy = await runtime(ws, { local: definition }); const auditPath = path.join(ws.root, 'audit.jsonl');
    const client = await memory(ws, proxy, new AuditLogger('stdio', 'info', auditPath));
    const result = await client.callTool(gateway('local', 'environment', {})); expect(result.structuredContent).toMatchObject({ allowed: 'explicit-secret', privateForwarded: false, argument: '$(touch SHELL-INJECTION);', cwd: ws.root });
    await client.callTool(gateway('local', 'echo', { message: 'PRIVATE-CONTENT' }));
    const audit = await readFile(auditPath, 'utf8'); expect(audit).toContain('mcp_call_tool'); expect(audit).toContain('local/environment'); for (const privateValue of ['explicit-secret', 'PRIVATE-CONTENT', ws.root, '$(touch']) expect(audit).not.toContain(privateValue);
    await expect(readFile(path.join(ws.root, 'SHELL-INJECTION'))).rejects.toThrow();
  });

  it('超大结果被拒绝，取消传递到上游且不重试写操作', async () => {
    const ws = await workspace(); const upstream = await httpUpstream(); cleanup.push(() => upstream.close());
    const proxy = await runtime(ws, { remote: { transport: 'http', url: upstream.url } });
    await expect(proxy.callTool('remote', 'large', { size: 1024 * 1024 })).rejects.toMatchObject({ code: 'OUTPUT_LIMIT_EXCEEDED' });
    const controller = new AbortController(); const pending = proxy.callTool('remote', 'delay', { milliseconds: 5000 }, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.waitFor(() => expect(upstream.state.calls.some(call => call.name === 'delay')).toBe(true)); controller.abort(); await rejected;
    await vi.waitFor(() => expect(upstream.state.cancelled).toBe(1));
    expect(upstream.state.calls.filter(call => call.name === 'delay')).toHaveLength(1);
    expect((await proxy.callTool('remote', 'echo', { message: 'still works' })).isError).not.toBe(true);
  });

  it('启动过程中取消也清理上游进程', async () => {
    const ws = await workspace(); const marker = path.join(ws.root, 'stall-started'); const controller = new AbortController();
    const pending = McpProxyRuntime.create(ws, { version: 1, mcpServers: { stall: local({ MCP_TEST_STALL: '1', MCP_TEST_START_MARKER: marker }) } }, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.waitFor(async () => expect((await readFile(marker, 'utf8')).trim()).toMatch(/^\d+$/u));
    const pid = Number((await readFile(marker, 'utf8')).trim()); controller.abort(); await rejected;
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
  });

  it('stdio 传输层超大消息有明确错误且不会影响内置工具', async () => {
    const ws = await workspace(); const proxy = await runtime(ws, { local: local() }); const client = await memory(ws, proxy);
    const oversized = await client.callTool(gateway('local', 'large', { size: 2 * 1024 * 1024 }));
    expect(oversized.isError).toBe(true); expect(JSON.stringify(oversized)).toContain('OUTPUT_LIMIT_EXCEEDED');
    expect((await client.callTool({ name: 'git_status', arguments: {} })).isError).not.toBe(true);
  });

  it('HTTP deadline 和客户端取消传递至共享上游，随后仍可调用', async () => {
    const errors = vi.spyOn(console, 'error');
    const ws = await workspace(); const upstream = await httpUpstream(); cleanup.push(() => upstream.close());
    const proxy = await runtime(ws, { remote: { transport: 'http', url: upstream.url } });
    const running = await startHttpServer(ws, { host: '127.0.0.1', port: 0, mcpPath: '/mcp', allowPublicBind: false, authToken: token, requestTimeoutMs: 200 }, undefined, { mcpProxy: proxy }); cleanup.push(() => running.close());
    const client = new Client({ name: 'deadline-proxy-test', version: '1' }); cleanup.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }) as unknown as Parameters<typeof client.connect>[0]);
    const timedOut = await fetch(running.url, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/call', params: gateway('remote', 'delay', { milliseconds: 5000 }) }) });
    expect(timedOut.status).toBe(408); expect(await timedOut.json()).toEqual({ error: 'request timeout' });
    await vi.waitFor(() => expect(upstream.state.cancelled).toBe(1));
    await expect(client.callTool(gateway('remote', 'delay', { milliseconds: 5000 }), undefined, { timeout: 50 })).rejects.toThrow();
    await vi.waitFor(() => expect(upstream.state.cancelled).toBe(2));
    expect((await client.callTool(gateway('remote', 'echo', { message: 'after cancellation' }))).isError).not.toBe(true);
    expect(upstream.state.calls.filter(call => call.name === 'delay')).toHaveLength(2);
    await client.close(); await running.close(); expect(errors).not.toHaveBeenCalled();
  });

  it('服务关闭会结束仍等待工具结果的 HTTP 请求', async () => {
    const errors = vi.spyOn(console, 'error'); const ws = await workspace();
    const upstream = await httpUpstream(); cleanup.push(() => upstream.close());
    const proxy = await runtime(ws, { remote: { transport: 'http', url: upstream.url } });
    const running = await startHttpServer(ws, { host: '127.0.0.1', port: 0, mcpPath: '/mcp', allowPublicBind: false, authToken: token }, undefined, { mcpProxy: proxy }); cleanup.push(() => running.close());
    const pending = fetch(running.url, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'tools/call', params: gateway('remote', 'delay', { milliseconds: 5000 }) }) });
    const ended = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(upstream.state.calls.some(call => call.name === 'delay')).toBe(true));
    await running.close(); await ended; expect(errors).not.toHaveBeenCalled();
  });

  it('HTTP GET 流在服务关闭时取消，响应结束没有后台异常', async () => {
    const errors = vi.spyOn(console, 'error'); const ws = await workspace();
    const running = await startHttpServer(ws, { host: '127.0.0.1', port: 0, mcpPath: '/mcp', allowPublicBind: false }); cleanup.push(() => running.close());
    const response = await fetch(running.url, { headers: { Accept: 'text/event-stream' } });
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('text/event-stream');
    const ended = expect(response.text()).rejects.toThrow();
    await running.close(); await ended; expect(errors).not.toHaveBeenCalled();
  });

  it('下游 stdio EOF 关闭上游，不留下后台子进程', async () => {
    const ws = await workspace(); const marker = path.join(ws.root, 'eof-parent'); const childMarker = path.join(ws.root, 'eof-child');
    await configure(ws, { local: local({ MCP_TEST_START_MARKER: marker, MCP_TEST_CHILD_MARKER: childMarker }) });
    const { client } = await cliClient(ws, ['--enable-mcp']);
    const parent = Number((await readFile(marker, 'utf8')).trim()); const child = Number(await readFile(childMarker, 'utf8'));
    await client.close(); await vi.waitFor(() => { expect(alive(parent)).toBe(false); expect(alive(child)).toBe(false); }, { timeout: 3000 });
  });
});
