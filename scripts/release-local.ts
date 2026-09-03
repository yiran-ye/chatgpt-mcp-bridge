import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { z } from 'zod/v4';

const argsSchema = z.tuple([z.enum(['patch', 'minor', 'major'])]).or(z.tuple([z.enum(['patch', 'minor', 'major']), z.literal('--yes')]));
const packageSchema = z.looseObject({ name: z.string().min(1), version: z.string().regex(/^\d+\.\d+\.\d+$/u) });
function fail(message: string): never { throw new Error(`发布已停止：${message}`); }
function run(command: string, args: string[], capture = false): string {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (result.error || result.status !== 0) fail(`${command} ${args[0] ?? ''} 执行失败${capture ? `：${result.stderr}` : ''}`);
  return capture ? result.stdout.trim() : '';
}
function nextVersion(current: string, type: 'patch' | 'minor' | 'major'): string {
  let [major, minor, patch] = current.split('.').map(Number) as [number, number, number];
  if (type === 'major') { major++; minor = 0; patch = 0; } else if (type === 'minor') { minor++; patch = 0; } else patch++;
  return `${major}.${minor}.${patch}`;
}

const parsed = argsSchema.safeParse(process.argv.slice(2)); if (!parsed.success) fail('用法：pnpm release <patch|minor|major> [--yes]');
const [type, yes] = parsed.data;
if (run('git', ['branch', '--show-current'], true) !== 'main') fail('必须在 main 分支发布');
if (run('git', ['status', '--porcelain'], true)) fail('工作区存在未提交修改');
run('git', ['fetch', 'origin', 'main']);
if (run('git', ['rev-parse', 'HEAD'], true) !== run('git', ['rev-parse', 'origin/main'], true)) fail('main 与 origin/main 未同步');
const packagePath = 'package.json'; const packageJson = packageSchema.parse(JSON.parse(await readFile(packagePath, 'utf8')) as unknown); const next = nextVersion(packageJson.version, type);
const changelog = await readFile('CHANGELOG.md', 'utf8'); const unreleased = /^## \[Unreleased\]\n([\s\S]*?)(?=^## )/mu.exec(changelog)?.[1]?.trim();
if (!unreleased) fail('CHANGELOG.md 的 Unreleased 段为空');
run('npm', ['whoami', '--registry=https://registry.npmjs.org/']); run('pnpm', ['check']); run('pnpm', ['smoke']); run('npm', ['pack', '--dry-run']);
if (yes !== '--yes') { const prompt = createInterface({ input: stdin, output: stdout }); const answer = await prompt.question(`准备发布 ${packageJson.name}@${next}。输入 PUBLISH 继续：`); prompt.close(); if (answer !== 'PUBLISH') fail('未确认发布'); }
const date = new Date().toISOString().slice(0, 10); const nextChangelog = changelog.replace(/^## \[Unreleased\]\n[\s\S]*?(?=^## )/mu, `## [Unreleased]\n\n## [${next}] - ${date}\n\n${unreleased}\n\n`);
await writeFile('CHANGELOG.md', nextChangelog); await writeFile(packagePath, `${JSON.stringify({ ...packageJson, version: next }, null, 2)}\n`);
run('git', ['add', '--', packagePath, 'CHANGELOG.md']); run('git', ['commit', '-m', `chore(release): v${next}`]); run('git', ['tag', '-a', `v${next}`, '-m', `chatgpt-mcp-bridge v${next}`]);
run('npm', ['pack', '--dry-run']); run('npm', ['publish', '--registry=https://registry.npmjs.org/', '--access', 'public']); run('git', ['push', 'origin', 'main', `v${next}`]);
process.stdout.write(`发布完成：${packageJson.name}@${next}\n`);
