import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../shared/errors.js';
import type { MutationCoordinator } from '../security/mutation-coordinator.js';
import type { CommandConfig } from '../runtime/access.js';
import type { WorkspaceContext } from '../workspace/workspace-context.js';

const MAX_ARGS = 64; const MAX_ARG_BYTES = 4096; const HARD_OUTPUT = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000; const MAX_TIMEOUT_MS = 600_000; const DEFAULT_OUTPUT_BYTES = 256 * 1024; const MIN_OUTPUT_BYTES = 1024;

export class CommandService {
  constructor(private readonly workspace: WorkspaceContext, private readonly config: CommandConfig, private readonly coordinator: MutationCoordinator) {}

  summaries(): Array<Record<string, unknown>> { return Object.entries(this.config.commands).map(([id, value]) => ({ id, description: value.description, allowAdditionalArgs: value.allowAdditionalArgs, timeoutMs: value.timeoutMs, maxOutputBytes: value.maxOutputBytes })); }

  async run(input: { commandId: string; args?: string[]; cwd?: string; timeoutMs?: number }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await this.coordinator.run(async () => {
      throwIfAborted(signal);
      const definition = this.config.commands[input.commandId];
      if (!definition) throw new AppError('COMMAND_NOT_ALLOWED', '命令不在允许列表中');
      const extra = input.args ?? [];
      if (!definition.allowAdditionalArgs && extra.length > 0) throw new AppError('COMMAND_NOT_ALLOWED', '该命令不允许附加参数');
      validateArgs(extra);
      const cwd = await this.workspace.paths.resolve(input.cwd ?? '.', { allowDirectory: true, allowIgnored: false });
      if (!cwd.stat.isDirectory()) throw new AppError('INVALID_INPUT', '命令 cwd 不是目录');
      const executable = await resolveExecutable(definition.executable);
      const timeoutMs = Math.min(input.timeoutMs ?? definition.timeoutMs, definition.timeoutMs, MAX_TIMEOUT_MS);
      return await execute(executable, [...definition.fixedArgs, ...extra], cwd.absolute, timeoutMs, Math.min(definition.maxOutputBytes, HARD_OUTPUT), definition.forwardEnv, this.workspace.root, { commandId: input.commandId }, signal);
    });
  }
}

export class FullAccessCommandService {
  constructor(private readonly workspace: WorkspaceContext, private readonly coordinator: MutationCoordinator) {}

  async run(input: { executable: string; args?: string[] | undefined; cwd?: string | undefined; timeoutMs?: number | undefined; maxOutputBytes?: number | undefined }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await this.coordinator.run(async () => {
      throwIfAborted(signal);
      const args = input.args ?? []; validateArgs(args); validateExecutableInput(input.executable);
      const cwd = await this.workspace.paths.resolve(input.cwd ?? '.', { allowDirectory: true, allowIgnored: false });
      if (!cwd.stat.isDirectory()) throw new AppError('INVALID_INPUT', '命令 cwd 不是目录');
      const executable = await resolveFullAccessExecutable(input.executable, this.workspace);
      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS; const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) throw new AppError('INVALID_INPUT', '命令 timeoutMs 无效');
      if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < MIN_OUTPUT_BYTES || maxOutputBytes > HARD_OUTPUT) throw new AppError('INVALID_INPUT', '命令 maxOutputBytes 无效');
      return await execute(executable.absolute, args, cwd.absolute, timeoutMs, maxOutputBytes, [], this.workspace.root, { executable: executable.display }, signal);
    });
  }
}

async function resolveExecutable(executable: string): Promise<string> {
  if (path.isAbsolute(executable)) { const resolved = await resolveExecutableFile(executable); if (resolved) return resolved; throw new AppError('COMMAND_NOT_ALLOWED', '配置的 executable 不存在或不是普通文件'); }
  const directories = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  const candidates = process.platform === 'win32' ? directories.flatMap(dir => ['', '.exe'].map(ext => path.join(dir, `${executable}${ext}`))) : directories.map(dir => path.join(dir, executable));
  for (const candidate of candidates) { const resolved = await resolveExecutableFile(candidate); if (resolved) return resolved; }
  throw new AppError('COMMAND_NOT_ALLOWED', '配置的 executable 无法解析');
}
async function resolveExecutableFile(candidate: string): Promise<string | undefined> {
  try { const resolved = await realpath(candidate); return (await stat(resolved)).isFile() ? resolved : undefined; } catch { return undefined; }
}
async function resolveFullAccessExecutable(input: string, workspace: WorkspaceContext): Promise<{ absolute: string; display: string }> {
  if (path.isAbsolute(input)) throw new AppError('PATH_OUTSIDE_WORKSPACE', 'full-access executable 不允许使用绝对路径');
  if (input === '.' || input === '..' || input.includes('/') || input.includes('\\')) {
    const resolved = await workspace.paths.resolve(input, { allowDirectory: false, allowIgnored: false });
    return { absolute: resolved.absolute, display: resolved.relative };
  }
  return { absolute: await resolveExecutable(input), display: input };
}
function validateExecutableInput(executable: string): void {
  if (executable.length === 0 || executable.includes('\0') || Buffer.byteLength(executable) > MAX_ARG_BYTES) throw new AppError('INVALID_INPUT', 'executable 无效或过长');
}
function validateArgs(args: string[]): void {
  if (args.length > MAX_ARGS) throw new AppError('INVALID_INPUT', '附加参数过多');
  if (args.some(value => value.includes('\0') || Buffer.byteLength(value) > MAX_ARG_BYTES)) throw new AppError('INVALID_INPUT', '附加参数无效或过长');
}
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw new AppError('TIMEOUT', '命令已取消'); }
function minimalEnv(forwardEnv: string[]): NodeJS.ProcessEnv {
  const names = new Set(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'COMSPEC', 'LANG', 'LC_ALL', ...forwardEnv]); const env: NodeJS.ProcessEnv = {};
  if (process.platform === 'win32') { names.add('PATHEXT'); names.add('SystemDrive'); }
  for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}
async function execute(executable: string, args: string[], cwd: string, timeoutMs: number, maxBytes: number, forwardEnv: string[], workspaceRoot: string, identity: { commandId?: string; executable?: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const started = Date.now(); const child = spawn(executable, args, { cwd, env: minimalEnv(forwardEnv), shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout: Buffer = Buffer.alloc(0); let stderr: Buffer = Buffer.alloc(0); let truncated = false; let timedOut = false; let cancelled = false; let terminationRequested = false;
    const append = (current: Buffer, chunk: Buffer): Buffer => { const remaining = Math.max(0, maxBytes - stdout.length - stderr.length); if (chunk.length > remaining) truncated = true; return remaining === 0 ? current : Buffer.concat([current, chunk.subarray(0, remaining)]); };
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); }); child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const terminate = (): void => { if (terminationRequested) return; terminationRequested = true; if (process.platform === 'win32') { if (child.pid) { const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, stdio: 'ignore' }); killer.unref(); } } else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } };
    const onAbort = (): void => { cancelled = true; terminate(); };
    let timer: NodeJS.Timeout | undefined; const cleanup = (): void => { if (timer) { clearTimeout(timer); timer = undefined; } signal?.removeEventListener('abort', onAbort); };
    child.once('error', () => { cleanup(); reject(new AppError('COMMAND_FAILED', '命令启动失败')); });
    timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true }); if (signal?.aborted) onAbort();
    child.once('close', (exitCode, closeSignal) => { cleanup(); if (cancelled) { reject(new AppError('TIMEOUT', '命令已取消')); return; } const secrets = forwardEnv.map(name => process.env[name]).filter((value): value is string => Boolean(value)); const redact = (value: string): string => secrets.reduce((text, secret) => text.replaceAll(secret, '<redacted>'), value.replaceAll(workspaceRoot, '<workspace>')); resolve({ ok: exitCode === 0 && !timedOut, ...identity, cwd: path.relative(workspaceRoot, cwd).replaceAll(path.sep, '/') || '.', exitCode, signal: closeSignal, timedOut, stdout: redact(stdout.toString('utf8')), stderr: redact(stderr.toString('utf8')), truncated, durationMs: Date.now() - started }); });
  });
}
