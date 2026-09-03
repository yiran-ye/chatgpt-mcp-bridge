import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../shared/errors.js';
import type { MutationCoordinator } from '../security/mutation-coordinator.js';
import type { CommandConfig, CommandDefinition } from '../runtime/access.js';
import type { WorkspaceContext } from '../workspace/workspace-context.js';

const MAX_ARGS = 64; const MAX_ARG_BYTES = 4096; const HARD_OUTPUT = 1024 * 1024;

export class CommandService {
  constructor(private readonly workspace: WorkspaceContext, private readonly config: CommandConfig, private readonly coordinator: MutationCoordinator) {}

  summaries(): Array<Record<string, unknown>> { return Object.entries(this.config.commands).map(([id, value]) => ({ id, description: value.description, allowAdditionalArgs: value.allowAdditionalArgs, timeoutMs: value.timeoutMs, maxOutputBytes: value.maxOutputBytes })); }

  async run(input: { commandId: string; args?: string[]; cwd?: string; timeoutMs?: number }): Promise<Record<string, unknown>> {
    return await this.coordinator.run(async () => {
      const definition = this.config.commands[input.commandId];
      if (!definition) throw new AppError('COMMAND_NOT_ALLOWED', '命令不在允许列表中');
      const extra = input.args ?? [];
      if (!definition.allowAdditionalArgs && extra.length > 0) throw new AppError('COMMAND_NOT_ALLOWED', '该命令不允许附加参数');
      validateArgs(extra);
      const cwd = await this.workspace.paths.resolve(input.cwd ?? '.', { allowDirectory: true, allowIgnored: false });
      if (!cwd.stat.isDirectory()) throw new AppError('INVALID_INPUT', '命令 cwd 不是目录');
      const executable = await resolveExecutable(definition.executable);
      const timeoutMs = Math.min(input.timeoutMs ?? definition.timeoutMs, definition.timeoutMs, 600_000);
      return await execute(executable, [...definition.fixedArgs, ...extra], cwd.absolute, timeoutMs, Math.min(definition.maxOutputBytes, HARD_OUTPUT), definition, this.workspace.root, input.commandId);
    });
  }
}

async function resolveExecutable(executable: string): Promise<string> {
  if (path.isAbsolute(executable)) { try { return await realpath(executable); } catch { throw new AppError('COMMAND_NOT_ALLOWED', '配置的 executable 不存在'); } }
  const directories = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  const candidates = process.platform === 'win32' ? directories.flatMap(dir => ['', '.exe'].map(ext => path.join(dir, `${executable}${ext}`))) : directories.map(dir => path.join(dir, executable));
  for (const candidate of candidates) try { return await realpath(candidate); } catch { /* continue */ }
  throw new AppError('COMMAND_NOT_ALLOWED', '配置的 executable 无法解析');
}
function validateArgs(args: string[]): void {
  if (args.length > MAX_ARGS) throw new AppError('INVALID_INPUT', '附加参数过多');
  if (args.some(value => value.includes('\0') || Buffer.byteLength(value) > MAX_ARG_BYTES)) throw new AppError('INVALID_INPUT', '附加参数无效或过长');
}
function minimalEnv(definition: CommandDefinition): NodeJS.ProcessEnv {
  const names = new Set(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'COMSPEC', 'LANG', 'LC_ALL', ...definition.forwardEnv]); const env: NodeJS.ProcessEnv = {};
  for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}
async function execute(executable: string, args: string[], cwd: string, timeoutMs: number, maxBytes: number, definition: CommandDefinition, workspaceRoot: string, commandId: string): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const started = Date.now(); const child = spawn(executable, args, { cwd, env: minimalEnv(definition), shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout: Buffer = Buffer.alloc(0); let stderr: Buffer = Buffer.alloc(0); let truncated = false; let timedOut = false;
    const append = (current: Buffer, chunk: Buffer): Buffer => { const remaining = Math.max(0, maxBytes - stdout.length - stderr.length); if (chunk.length > remaining) truncated = true; return remaining === 0 ? current : Buffer.concat([current, chunk.subarray(0, remaining)]); };
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); }); child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once('error', error => reject(new AppError('COMMAND_FAILED', `命令启动失败：${error.message}`)));
    const timer = setTimeout(() => { timedOut = true; if (process.platform === 'win32') { const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, stdio: 'ignore' }); killer.unref(); } else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } }, timeoutMs);
    child.once('close', (exitCode, signal) => { clearTimeout(timer); const secrets = definition.forwardEnv.map(name => process.env[name]).filter((value): value is string => Boolean(value)); const redact = (value: string): string => secrets.reduce((text, secret) => text.replaceAll(secret, '<redacted>'), value.replaceAll(workspaceRoot, '<workspace>')); resolve({ ok: exitCode === 0 && !timedOut, commandId, cwd: path.relative(workspaceRoot, cwd).replaceAll(path.sep, '/') || '.', exitCode, signal, timedOut, stdout: redact(stdout.toString('utf8')), stderr: redact(stderr.toString('utf8')), truncated, durationMs: Date.now() - started }); });
  });
}
