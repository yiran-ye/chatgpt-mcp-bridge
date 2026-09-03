import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createFixture, type GitFixture } from '../helpers/git-fixture.js';
import { WorkspaceContext } from '../../src/workspace/workspace-context.js';
import { MutationCoordinator } from '../../src/security/mutation-coordinator.js';
import { PatchService, sha256 } from '../../src/workspace/patch-service.js';
import { CommandService } from '../../src/command/command-service.js';
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
});
