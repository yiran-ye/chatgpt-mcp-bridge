import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { AuditLogger } from '../../src/security/audit-logger.js';
import { globalOptionOutput, HELP_TEXT, isMainModule, parseArgs } from '../../src/cli.js';
import { defaultCommandConfigPath, loadCommandConfig, resolveCommandConfigPath } from '../../src/runtime/command-config.js';
import { PACKAGE_VERSION } from '../../src/shared/version.js';
import { AppError, safeError } from '../../src/shared/errors.js';
import { WorkspaceContext } from '../../src/workspace/workspace-context.js';
import { releaseNotes } from '../../scripts/release-notes.js';

describe('日志与 CLI', () => {
  it('npm 包同时注册完整命令和 cmb 缩写', () => {
    const packageJson = createRequire(import.meta.url)('../../package.json') as { bin: Record<string, string> };
    expect(packageJson.bin).toEqual({ 'chatgpt-mcp-bridge': 'dist/cli.js', cmb: 'dist/cli.js' });
  });
  it('日志不写正文、Token、绝对 workspace', async () => { const directory = await mkdtemp(path.join(tmpdir(), 'audit-test-')); const file = path.join(directory, 'audit.jsonl'); try { const logger = new AuditLogger('http', 'info', file); await logger.event('read_file', 'allow', 3, 20, undefined, 'src/a.ts'); const content = await readFile(file, 'utf8'); expect(content).not.toContain('SECRET-CONTENT'); expect(content).not.toContain('TOKEN'); expect(content).not.toContain('/Users/'); expect(content).toContain('src/a.ts'); } finally { await rm(directory, { recursive: true, force: true }); } });
  it('CLI 默认只监听 127.0.0.1:8765/mcp 且只读', () => expect(parseArgs(['serve', '.'])).toMatchObject({ host: '127.0.0.1', port: 8765, mcpPath: '/mcp', transport: 'http', access: 'read-only' }));
  it('CLI 解析显式访问模式和命令配置', () => expect(parseArgs(['serve', '.', '--access', 'command-exec', '--config', '/tmp/commands.json'])).toMatchObject({ access: 'command-exec', configPath: '/tmp/commands.json' }));
  it('CLI 兼容 pnpm 传入的 -- 分隔符', () => expect(parseArgs(['--', 'serve', '.'])).toMatchObject({ host: '127.0.0.1', port: 8765 }));
  it('CLI 用明确错误拒绝未知参数', () => expect(() => parseArgs(['serve', '.', '--run-command', 'id'])).toThrow(new AppError('INVALID_INPUT', '未知参数：--run-command')));
  it('CLI 用明确错误说明缺少 workspace', () => expect(() => parseArgs(['config'])).toThrow(new AppError('INVALID_INPUT', '缺少 workspace；请提供工作区路径，例如：chatgpt-mcp-bridge config .')));
  it('CLI 用明确错误说明参数值无效', () => expect(() => parseArgs(['serve', '.', '--port', 'abc'])).toThrow(new AppError('INVALID_INPUT', '参数 --port 的值无效')));
  it('CLI 限制外部参数的数量和长度', () => expect(() => parseArgs(Array.from({ length: 129 }, () => 'x'))).toThrow(new AppError('INVALID_INPUT', 'CLI 参数数量过多或包含非法内容')));
  it('真正的内部异常仍隐藏实现细节', () => expect(safeError(new Error('SECRET-INTERNAL-DETAIL'))).toMatchObject({ code: 'INTERNAL_ERROR', message: '操作失败，服务器已隐藏内部细节' }));
  it('CLI 输出版本号', () => expect(globalOptionOutput(['--version'])).toBe(`${PACKAGE_VERSION}\n`));
  it('CLI 输出帮助信息', () => {
    expect(globalOptionOutput(['--help'])).toBe(HELP_TEXT);
    expect(HELP_TEXT).toContain('chatgpt-mcp-bridge <command>');
    expect(HELP_TEXT).toContain('cmb <command>');
    expect(HELP_TEXT).toContain('~/.chatgpt-mcp-bridge/config.json');
  });
  it('CLI 不会吞掉带额外参数的全局选项', () => expect(globalOptionOutput(['--help', 'serve'])).toBeUndefined());
  it('默认命令配置固定放在用户目录', () => expect(defaultCommandConfigPath()).toBe(path.join(homedir(), '.chatgpt-mcp-bridge', 'config.json')));
  it('项目配置优先于全局配置，显式配置优先于项目配置', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'config-priority-test-')); const projectConfig = path.join(directory, '.chatgpt-mcp-bridge', 'config.json'); const explicit = path.join(directory, 'explicit.json');
    const value = { version: 1, commands: { test: { description: 'test', executable: process.execPath, fixedArgs: [], allowAdditionalArgs: false, forwardEnv: [], timeoutMs: 1000, maxOutputBytes: 1024 } } };
    try {
      await mkdir(path.dirname(projectConfig)); await writeFile(projectConfig, JSON.stringify(value)); await writeFile(explicit, JSON.stringify(value));
      const workspace = await WorkspaceContext.create(directory); const project = await resolveCommandConfigPath(undefined, workspace); const selected = await resolveCommandConfigPath(explicit, workspace);
      expect(project).toMatchObject({ path: await realpath(projectConfig), source: 'project', exists: true });
      expect(selected).toMatchObject({ path: await realpath(explicit), source: 'explicit', exists: true });
      expect(Object.keys((await loadCommandConfig(undefined, workspace)).commands)).toEqual(['test']);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('项目配置不存在时回退到全局路径', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'config-fallback-test-'));
    try { expect(await resolveCommandConfigPath(undefined, await WorkspaceContext.create(directory))).toMatchObject({ path: defaultCommandConfigPath(), source: 'global' }); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  it.skipIf(process.platform === 'win32')('拒绝指向 workspace 外部的项目配置符号链接', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'config-link-test-')); const outside = path.join(path.dirname(directory), `${path.basename(directory)}-outside.json`);
    try {
      await mkdir(path.join(directory, '.chatgpt-mcp-bridge')); await writeFile(outside, '{}'); await symlink(outside, path.join(directory, '.chatgpt-mcp-bridge', 'config.json'));
      await expect(resolveCommandConfigPath(undefined, await WorkspaceContext.create(directory))).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
    } finally { await rm(directory, { recursive: true, force: true }); await rm(outside, { force: true }); }
  });
  it.skipIf(process.platform === 'win32')('CLI 入口识别可解析全局安装符号链接', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cli-link-test-'));
    try {
      const source = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
      const link = path.join(directory, 'chatgpt-mcp-bridge');
      await symlink(source, link);
      expect(isMainModule(link, new URL('../../src/cli.ts', import.meta.url).href)).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('命令配置严格校验且拒绝未知字段', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'command-config-test-')); const valid = path.join(directory, 'valid.json'); const invalid = path.join(directory, 'invalid.json');
    try {
      await writeFile(valid, JSON.stringify({ version: 1, commands: { test: { description: 'test', executable: process.execPath, fixedArgs: [], allowAdditionalArgs: false, forwardEnv: [], timeoutMs: 1000, maxOutputBytes: 1024 } } }));
      await writeFile(invalid, JSON.stringify({ version: 1, commands: { test: { description: 'test', executable: process.execPath, surprise: true } } }));
      expect(Object.keys((await loadCommandConfig(valid)).commands)).toEqual(['test']);
      await expect(loadCommandConfig(invalid)).rejects.toMatchObject({ code: 'COMMAND_CONFIG_INVALID' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('可以从 Changelog 精确提取版本说明', async () => { expect(await releaseNotes('0.2.2')).toContain('Secure MCP Tunnel'); await expect(releaseNotes('9.9.9')).rejects.toThrow(); });
});
