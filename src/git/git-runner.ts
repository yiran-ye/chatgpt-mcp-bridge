import { spawn } from 'node:child_process';
import { AppError } from '../shared/errors.js';

export interface CommandResult { stdout: Buffer; stderr: string }

export class GitRunner {
  constructor(private readonly root: string) {}
  async run(args: readonly string[], options: { maxBytes?: number; timeoutMs?: number } = {}): Promise<CommandResult> {
    const fixed = ['-c', 'core.pager=cat', '-c', 'pager.diff=false', '-c', 'diff.external=', '-c', 'color.ui=false', ...args];
    return await runProcess('git', fixed, this.root, options.maxBytes ?? 8 * 1024 * 1024, options.timeoutMs ?? 10_000, 'GIT_COMMAND_FAILED');
  }
}

export async function runProcess(executable: 'git' | 'rg', args: readonly string[], cwd: string, maxBytes: number, timeoutMs: number, errorCode: 'GIT_COMMAND_FAILED' | 'SEARCH_TOOL_UNAVAILABLE'): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', GIT_PAGER: 'cat', PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    });
    const output: Buffer[] = []; const errors: Buffer[] = []; let bytes = 0; let settled = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new AppError('TIMEOUT', `${executable} 操作超时`)); }, timeoutMs);
    const finish = (error?: AppError, result?: CommandResult): void => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else if (result) resolve(result); };
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > maxBytes) { child.kill('SIGKILL'); finish(new AppError('OUTPUT_LIMIT_EXCEEDED', '子进程输出超过安全上限')); } else output.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { if (Buffer.concat(errors).length < 16_384) errors.push(chunk); });
    child.on('error', () => finish(new AppError(errorCode, `${executable} 不可用或无法启动`)));
    child.on('close', code => { const stderr = Buffer.concat(errors).toString('utf8').slice(0, 1000); if (settled) return; if (code !== 0) finish(new AppError(errorCode, `${executable} 操作失败：${redact(stderr)}`)); else finish(undefined, { stdout: Buffer.concat(output), stderr }); });
  });
}

function redact(value: string): string { return value.replace(/(?:https?:\/\/)[^\s@]+@/gu, 'https://[redacted]@').replace(/\/(?:Users|home)\/[^/\s]+/gu, '/[home]'); }
