import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { z } from 'zod/v4';
import { releaseNotes } from './release-notes.js';

const versionSchema = z.string().regex(/^v(\d+)\.(\d+)\.(\d+)$/u);
const flagSchema = z.enum(['--historical', '--latest=false']);
const packageSchema = z.object({ name: z.string().min(1), version: z.string().regex(/^\d+\.\d+\.\d+$/u) });

function run(args: string[], capture = false): string {
  const result = spawnSync('gh', args, { encoding: 'utf8', shell: false, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(capture ? result.stderr : `gh ${args[0] ?? ''} 执行失败`);
  return capture ? result.stdout.trim() : '';
}

const passedArgs = process.argv.slice(2); const rawArgs = passedArgs[0] === '--' ? passedArgs.slice(1) : passedArgs; const tag = versionSchema.safeParse(rawArgs[0]); const flags = z.array(flagSchema).max(2).safeParse(rawArgs.slice(1));
if (!tag.success || !flags.success || new Set(flags.data).size !== flags.data.length) throw new Error('用法：tsx scripts/github-release.ts vX.Y.Z [--historical] [--latest=false]');
const version = tag.data.slice(1); const historical = flags.data.some(flag => flag === '--historical'); const latestFalse = flags.data.some(flag => flag === '--latest=false');
const packageJson = packageSchema.parse(JSON.parse(await readFile('package.json', 'utf8')) as unknown);
if (!historical && packageJson.version !== version) throw new Error(`tag ${tag} 与 package.json ${packageJson.version} 不一致`);
const notes = await releaseNotes(version); const body = `${notes}\n\n- npm：https://www.npmjs.com/package/${packageJson.name}/v/${version}`;
const title = `${packageJson.name} ${tag.data}`;
const exists = spawnSync('gh', ['release', 'view', tag.data], { encoding: 'utf8', shell: false, stdio: 'ignore' }).status === 0;
const args = ['release', exists ? 'edit' : 'create', tag.data, '--verify-tag', '--title', title, '--notes', body];
if (latestFalse) args.push('--latest=false');
run(args);
