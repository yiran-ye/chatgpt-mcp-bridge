import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceContext } from '../../src/workspace/workspace-context.js';
import { inspectMcpConfig, loadMcpConfig, loadOptionalMcpConfig, MCP_CONFIG_PATH, parseMcpConfig, resolveMcpEnvironment } from '../../src/runtime/mcp-config.js';
import { McpProxyRuntime } from '../../src/mcp/proxy-runtime.js';
import { parseArgs } from '../../src/cli.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function workspace(): Promise<WorkspaceContext> { const root = await mkdtemp(path.join(tmpdir(), 'mcp-config-')); directories.push(root); await mkdir(path.join(root, '.chatgpt-mcp-bridge')); return await WorkspaceContext.create(root); }
const valid = { version: 1, mcpServers: { local: { transport: 'stdio', command: 'node' }, remote: { transport: 'http', url: 'http://127.0.0.1:9000/mcp', headers: { Authorization: 'Bearer ${env:MY_TOKEN}' } } } };

describe('项目 MCP 配置安全边界', () => {
  it('兼容旧 --enable-mcp 参数且不改变内置访问模式', () => {
    expect(parseArgs(['serve', '.'])).toMatchObject({ enableMcp: false, access: 'read-only' });
    expect(parseArgs(['serve', '.', '--enable-mcp'])).toMatchObject({ enableMcp: true, access: 'read-only' });
  });
  it('严格校验配置并设置默认值', () => {
    expect(parseMcpConfig(valid).mcpServers['local']).toEqual({ transport: 'stdio', command: 'node', args: [], cwd: '.', env: {} });
    for (const value of [{ ...valid, surprise: true }, { ...valid, version: 2 }, { version: 1, mcpServers: { local: { transport: 'stdio', command: 'node', shell: true } } }, { version: 1, mcpServers: { remote: { transport: 'http', url: 'file:///etc/passwd' } } }]) expect(() => parseMcpConfig(value)).toThrow();
  });
  it('拒绝绝对可执行文件、NUL、URL 凭据和请求头注入', () => {
    for (const command of ['/bin/sh', 'C:\\Windows\\cmd.exe', 'bad\0command']) expect(() => parseMcpConfig({ version: 1, mcpServers: { local: { transport: 'stdio', command } } })).toThrow();
    for (const url of ['https://user:password@example.com/mcp', 'https://example.com/mcp#fragment']) expect(() => parseMcpConfig({ version: 1, mcpServers: { remote: { transport: 'http', url } } })).toThrow();
    expect(() => parseMcpConfig({ version: 1, mcpServers: { remote: { transport: 'http', url: 'https://example.com', headers: { Authorization: 'ok\r\nBad: injected' } } } })).toThrow();
  });
  it('仅展开 env 和 headers，并重新校验；错误中不泄露值', () => {
    const input = parseMcpConfig({ version: 1, mcpServers: { local: { transport: 'stdio', command: 'node', args: ['${env:MY_TOKEN}'], env: { TOKEN: '${env:MY_TOKEN}' } }, remote: valid.mcpServers.remote } });
    const result = resolveMcpEnvironment(input, { MY_TOKEN: 'private-token' });
    expect(result.mcpServers['local']).toMatchObject({ args: ['${env:MY_TOKEN}'], env: { TOKEN: 'private-token' } });
    expect(result.mcpServers['remote']).toMatchObject({ headers: { Authorization: 'Bearer private-token' } });
    expect(() => resolveMcpEnvironment(input, {})).toThrow(/环境变量未设置/u);
    expect(() => resolveMcpEnvironment(input, { MY_TOKEN: 'private\r\nsecret' })).toThrow(/配置无效/u);
  });
  it('读取受保护的配置，普通文件入口仍拒绝访问', async () => {
    const ws = await workspace(); await writeFile(path.join(ws.root, MCP_CONFIG_PATH), JSON.stringify({ version: 1, mcpServers: { local: valid.mcpServers.local } }));
    expect(await loadMcpConfig(ws)).toMatchObject({ version: 1 });
    await expect(ws.paths.resolve(MCP_CONFIG_PATH)).rejects.toMatchObject({ code: 'PATH_BLOCKED' });
    expect(await inspectMcpConfig(ws)).toEqual({ path: MCP_CONFIG_PATH, exists: true, servers: [{ id: 'local', transport: 'stdio' }] });
  });
  it('拒绝越界符号链接、无效 UTF-8、过大配置和非 JSON', async () => {
    const ws = await workspace(); const outside = await workspace(); const file = path.join(ws.root, MCP_CONFIG_PATH); const target = path.join(outside.root, 'outside.json');
    await writeFile(target, JSON.stringify(valid)); await symlink(target, file);
    await expect(loadMcpConfig(ws)).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' }); await rm(file);
    for (const value of [Buffer.from([0xff, 0xfe]), Buffer.alloc(65 * 1024, 'x'), Buffer.from('not-json')]) { await writeFile(file, value); await expect(loadMcpConfig(ws)).rejects.toMatchObject({ code: 'MCP_CONFIG_INVALID' }); }
  });
  it('配置缺失时摘要明确显示，显式创建运行时仍要求配置', async () => {
    const ws = await workspace(); expect(await inspectMcpConfig(ws)).toMatchObject({ exists: false, servers: [] });
    await expect(McpProxyRuntime.create(ws)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });
  it('自动检测拒绝悬空配置链接和非目录父路径，不当作没有配置', async () => {
    const ws = await workspace(); const file = path.join(ws.root, MCP_CONFIG_PATH);
    await symlink(path.join(ws.root, 'missing.json'), file);
    await expect(loadOptionalMcpConfig(ws)).rejects.toMatchObject({ code: 'PATH_BLOCKED' });
    await rm(file); await rm(path.dirname(file), { recursive: true });
    await writeFile(path.dirname(file), 'not a directory');
    await expect(loadOptionalMcpConfig(ws)).rejects.toMatchObject({ code: 'PATH_BLOCKED' });
  });
  it('配置内部缺失的 cwd 或 executable 不会被诊断为没有配置', async () => {
    const ws = await workspace();
    for (const local of [{ transport: 'stdio', command: 'node', cwd: 'missing-cwd' }, { transport: 'stdio', command: './missing-executable' }]) {
      await writeFile(path.join(ws.root, MCP_CONFIG_PATH), JSON.stringify({ version: 1, mcpServers: { local } }));
      await expect(inspectMcpConfig(ws)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    }
  });
  it('cwd 和相对 executable 不允许越界，即使另有可用服务', async () => {
    const ws = await workspace();
    for (const definition of [{ transport: 'stdio', command: 'node', cwd: '..' }, { transport: 'stdio', command: '../node' }]) await expect(McpProxyRuntime.create(ws, { version: 1, mcpServers: { local: definition } })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
  });
});
