import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createFixture, type GitFixture } from '../helpers/git-fixture.js';
import { WorkspaceContext } from '../../src/workspace/workspace-context.js';
import { MutationCoordinator } from '../../src/security/mutation-coordinator.js';
import { PatchService, sha256 } from '../../src/workspace/patch-service.js';
import { CommandService, FullAccessCommandService } from '../../src/command/command-service.js';
import type { CommandConfig } from '../../src/runtime/access.js';

describe('写入与命令安全边界', () => {
  let fixture: GitFixture; let workspace: WorkspaceContext; let patches: PatchService;
  beforeEach(async () => { fixture = await createFixture(); workspace = await WorkspaceContext.create(fixture.root); patches = new PatchService(workspace, new MutationCoordinator()); });
  afterEach(async () => fixture.cleanup());

  it('创建、更新和删除文件并校验哈希', async () => {
    await patches.apply({ operation: 'create_file', path: 'created.txt', diff: '--- /dev/null\n+++ b/created.txt\n@@ -0,0 +1 @@\n+hello\n' });
    expect(await readFile(path.join(fixture.root, 'created.txt'), 'utf8')).toBe('hello\n');
    const before = await readFile(path.join(fixture.root, 'tracked.ts'), 'utf8');
    const result = await patches.apply({ operation: 'update_file', path: 'tracked.ts', expectedSha256: sha256(before), diff: '--- a/tracked.ts\n+++ b/tracked.ts\n@@ -1,2 +1,2 @@\n-export const value = 2;\n+export const value = 3;\n export const changed = true;\n' });
    expect(result['afterSha256']).toBe(sha256(await readFile(path.join(fixture.root, 'tracked.ts'))));
    const created = await readFile(path.join(fixture.root, 'created.txt'), 'utf8');
    await patches.apply({ operation: 'delete_file', path: 'created.txt', expectedSha256: sha256(created) });
    await expect(readFile(path.join(fixture.root, 'created.txt'))).rejects.toThrow();
  });

  it('拒绝冲突、敏感路径、ignore、Git 与越界创建', async () => {
    await expect(patches.apply({ operation: 'update_file', path: 'tracked.ts', expectedSha256: '0'.repeat(64), diff: '--- a/tracked.ts\n+++ b/tracked.ts\n@@ -1 +1 @@\n-x\n+y\n' })).rejects.toMatchObject({ code: 'PATCH_CONFLICT' });
    for (const blocked of ['.env', 'ignored.txt', '.git/config', '.chatgpt-mcp-bridge-ignore', '../outside.txt']) {
      await expect(patches.apply({ operation: 'create_file', path: blocked, diff: `--- /dev/null\n+++ b/${blocked}\n@@ -0,0 +1 @@\n+x\n` })).rejects.toHaveProperty('code');
    }
  });

  it('命令只运行目录中的 executable 且不解析 shell 元字符', async () => {
    const config: CommandConfig = { version: 1, commands: { echo_arg: { description: '输出参数', executable: process.execPath, fixedArgs: ['-e', 'process.stdout.write(process.argv[1] ?? "")'], allowAdditionalArgs: true, forwardEnv: [], timeoutMs: 5000, maxOutputBytes: 4096 } } };
    const commands = new CommandService(workspace, config, new MutationCoordinator());
    const marker = '; touch should-not-exist'; const result = await commands.run({ commandId: 'echo_arg', args: [marker] });
    expect(result).toMatchObject({ ok: true, stdout: marker, timedOut: false });
    await expect(readFile(path.join(fixture.root, 'should-not-exist'))).rejects.toThrow();
    await expect(commands.run({ commandId: 'unknown' })).rejects.toMatchObject({ code: 'COMMAND_NOT_ALLOWED' });
  });

  it('命令限制 cwd、附加参数和输出', async () => {
    const config: CommandConfig = { version: 1, commands: { fixed: { description: '固定输出', executable: process.execPath, fixedArgs: ['-e', 'process.stdout.write("x".repeat(5000))'], allowAdditionalArgs: false, forwardEnv: [], timeoutMs: 5000, maxOutputBytes: 1024 } } };
    const commands = new CommandService(workspace, config, new MutationCoordinator());
    expect(await commands.run({ commandId: 'fixed' })).toMatchObject({ ok: true, truncated: true });
    await expect(commands.run({ commandId: 'fixed', args: ['extra'] })).rejects.toMatchObject({ code: 'COMMAND_NOT_ALLOWED' });
    await expect(commands.run({ commandId: 'fixed', cwd: '../' })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
  });

  it('命令配置中的 executable 必须解析为普通文件', async () => {
    const config: CommandConfig = { version: 1, commands: { directory: { description: '目录不是 executable', executable: fixture.root, fixedArgs: [], allowAdditionalArgs: false, forwardEnv: [], timeoutMs: 5000, maxOutputBytes: 4096 } } };
    await expect(new CommandService(workspace, config, new MutationCoordinator()).run({ commandId: 'directory' })).rejects.toMatchObject({ code: 'COMMAND_NOT_ALLOWED' });
  });

  it('命令超时并遮蔽显式转发的环境值', async () => {
    const envName = 'CHATGPT_MCP_BRIDGE_TEST_SECRET'; process.env[envName] = 'bridge-test-secret-value';
    try {
      const config: CommandConfig = { version: 1, commands: {
        env: { description: '输出测试环境', executable: process.execPath, fixedArgs: ['-e', `process.stdout.write(process.env.${envName} ?? "")`], allowAdditionalArgs: false, forwardEnv: [envName], timeoutMs: 5000, maxOutputBytes: 4096 },
        slow: { description: '超时测试', executable: process.execPath, fixedArgs: ['-e', 'setInterval(() => {}, 1000)'], allowAdditionalArgs: false, forwardEnv: [], timeoutMs: 100, maxOutputBytes: 4096 },
      } };
      const commands = new CommandService(workspace, config, new MutationCoordinator());
      expect(await commands.run({ commandId: 'env' })).toMatchObject({ stdout: '<redacted>' });
      expect(await commands.run({ commandId: 'slow' })).toMatchObject({ ok: false, timedOut: true });
    } finally { Reflect.deleteProperty(process.env, envName); }
  });

  it('full-access 直接运行 PATH executable、隔离环境且不解析 shell 元字符', async () => {
    const envName = 'CHATGPT_MCP_BRIDGE_FULL_ACCESS_SECRET'; process.env[envName] = 'full-access-secret-value';
    try {
      const commands = new FullAccessCommandService(workspace, new MutationCoordinator()); const marker = '; touch full-access-should-not-exist';
      const result = await commands.run({ executable: path.basename(process.execPath), args: ['-e', `process.stdout.write((process.argv[1] ?? '') + '|' + (process.env.${envName} ?? ''))`, marker] });
      expect(result).toMatchObject({ ok: true, executable: path.basename(process.execPath), stdout: `${marker}|`, timedOut: false });
      await expect(readFile(path.join(fixture.root, 'full-access-should-not-exist'))).rejects.toThrow();
    } finally { Reflect.deleteProperty(process.env, envName); }
  });

  it.skipIf(process.platform === 'win32')('full-access 运行经过 PathPolicy 的工作区相对 executable', async () => {
    const executable = path.join(fixture.root, 'workspace-command'); await writeFile(executable, '#!/usr/bin/env node\nprocess.stdout.write(process.argv[2] ?? "")\n'); await chmod(executable, 0o755);
    const commands = new FullAccessCommandService(workspace, new MutationCoordinator());
    expect(await commands.run({ executable: './workspace-command', args: ['relative-ok'] })).toMatchObject({ ok: true, executable: 'workspace-command', stdout: 'relative-ok' });
  });

  it('full-access 限制 executable、cwd、参数、超时和输出', async () => {
    const commands = new FullAccessCommandService(workspace, new MutationCoordinator()); const node = path.basename(process.execPath);
    await expect(commands.run({ executable: process.execPath })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
    await expect(commands.run({ executable: '.' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(commands.run({ executable: '..' })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
    await expect(commands.run({ executable: './ignored.txt' })).rejects.toMatchObject({ code: 'PATH_BLOCKED' });
    await expect(commands.run({ executable: './.env' })).rejects.toMatchObject({ code: 'SENSITIVE_FILE' });
    await expect(commands.run({ executable: './escape-link' })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
    await expect(commands.run({ executable: node, cwd: '../' })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
    await expect(commands.run({ executable: node, args: ['\0'] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(commands.run({ executable: node, args: Array.from({ length: 65 }, () => 'x') })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(commands.run({ executable: node, maxOutputBytes: 100 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await commands.run({ executable: node, args: ['-e', 'process.stdout.write(process.cwd())'] })).toMatchObject({ ok: true, stdout: '<workspace>' });
    expect(await commands.run({ executable: node, args: ['-e', 'process.stdout.write("x".repeat(5000))'], maxOutputBytes: 1024 })).toMatchObject({ ok: true, truncated: true });
    expect(await commands.run({ executable: node, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 100 })).toMatchObject({ ok: false, timedOut: true });
  });

  it('full-access 的 PATH executable 必须解析为普通文件', async () => {
    const directoryName = 'not-an-executable'; await mkdir(path.join(fixture.root, directoryName)); const originalPath = process.env['PATH']; process.env['PATH'] = `${fixture.root}${path.delimiter}${originalPath ?? ''}`;
    try { await expect(new FullAccessCommandService(workspace, new MutationCoordinator()).run({ executable: directoryName })).rejects.toMatchObject({ code: 'COMMAND_NOT_ALLOWED' }); }
    finally { if (originalPath === undefined) Reflect.deleteProperty(process.env, 'PATH'); else process.env['PATH'] = originalPath; }
  });

  it.skipIf(process.platform === 'win32')('full-access 启动失败后立即完成清理', async () => {
    await expect(new FullAccessCommandService(workspace, new MutationCoordinator()).run({ executable: './tracked.ts', timeoutMs: 600_000 })).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
  });

  it('full-access 收到取消信号后终止进程并释放互斥队列', async () => {
    const commands = new FullAccessCommandService(workspace, new MutationCoordinator()); const controller = new AbortController(); const marker = 'cancelled-command-marker';
    const pending = commands.run({ executable: path.basename(process.execPath), args: ['-e', `setTimeout(() => require('node:fs').writeFileSync('${marker}', 'unexpected'), 500)`], timeoutMs: 5000 }, controller.signal);
    const cancelTimer = setTimeout(() => controller.abort(), 100);
    try { await expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' }); } finally { clearTimeout(cancelTimer); }
    await new Promise(resolve => setTimeout(resolve, 600)); await expect(readFile(path.join(fixture.root, marker))).rejects.toThrow();
    expect(await commands.run({ executable: path.basename(process.execPath), args: ['-e', 'process.stdout.write("released")'] })).toMatchObject({ ok: true, stdout: 'released' });
  });
});
