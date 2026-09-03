import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface GitFixture { root: string; outside: string; cleanup(): Promise<void> }
export function git(root: string, args: string[]): string { return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1' } }).trim(); }
export async function createFixture(): Promise<GitFixture> {
  const parent = await mkdtemp(path.join(tmpdir(), 'chatgpt-mcp-bridge-test-')); const root = path.join(parent, 'repo'); const outside = path.join(parent, 'outside.txt'); await mkdir(root); await writeFile(outside, 'outside secret\n');
  git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'Test']); git(root, ['config', 'user.email', 'test@localhost.invalid']);
  await writeFile(path.join(root, 'tracked.ts'), 'export const value = 1;\n'); await writeFile(path.join(root, 'rename-me.ts'), 'export const old = true;\n'); await writeFile(path.join(root, 'delete-me.ts'), 'delete me\n'); await writeFile(path.join(root, 'AGENTS.md'), '# Fixture rules\n');
  git(root, ['add', '.']); git(root, ['commit', '-m', 'initial']); git(root, ['switch', '-c', 'feature']); await writeFile(path.join(root, 'feature.ts'), 'export const feature = true;\n'); git(root, ['add', 'feature.ts']); git(root, ['commit', '-m', 'feature']);
  await writeFile(path.join(root, 'tracked.ts'), 'export const value = 2;\nexport const changed = true;\n'); await writeFile(path.join(root, 'staged.ts'), 'export const staged = true;\n'); git(root, ['add', 'staged.ts']); git(root, ['mv', 'rename-me.ts', 'renamed.ts']); await rm(path.join(root, 'delete-me.ts')); await writeFile(path.join(root, 'untracked.ts'), 'export const needle = "found";\n');
  await writeFile(path.join(root, '.env'), 'TOKEN=very-secret-value\n'); await writeFile(path.join(root, 'private.pem'), 'PRIVATE KEY BODY\n'); await writeFile(path.join(root, 'application-prod.yml'), 'password: hidden\n'); await writeFile(path.join(root, 'SecretService.java'), 'class SecretService { String safe = "needle"; }\n'); await writeFile(path.join(root, 'large.txt'), 'x'.repeat(1024 * 1024 + 1)); await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3])); await writeFile(path.join(root, '.chatgpt-mcp-bridge-ignore'), 'ignored.txt\n'); await writeFile(path.join(root, 'ignored.txt'), 'needle hidden\n'); await symlink(outside, path.join(root, 'escape-link'));
  return { root, outside, cleanup: async () => rm(parent, { recursive: true, force: true }) };
}

export async function createConflictFixture(): Promise<GitFixture> {
  const fixture = await createFixture(); git(fixture.root, ['add', '-A']); git(fixture.root, ['commit', '-m', 'work']); git(fixture.root, ['switch', 'main']); await writeFile(path.join(fixture.root, 'tracked.ts'), 'main side\n'); git(fixture.root, ['add', 'tracked.ts']); git(fixture.root, ['commit', '-m', 'main side']); try { git(fixture.root, ['merge', 'feature']); } catch { /* expected conflict */ } return fixture;
}
