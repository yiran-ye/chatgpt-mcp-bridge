import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { AppError } from '../shared/errors.js';

export const MAX_UPSTREAM_MESSAGE_BYTES = 1024 * 1024 + 64 * 1024;

/** A bounded stdio transport whose lifetime includes the complete child process tree. */
export class ManagedStdioClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  #child: ChildProcessWithoutNullStreams | undefined;
  #buffer: Buffer = Buffer.alloc(0);
  #closing: Promise<void> | undefined;
  #closed = false;
  #exited: Promise<void> = Promise.resolve();

  constructor(private readonly options: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }) {}

  async start(): Promise<void> {
    if (this.#child || this.#closed) throw new AppError('MCP_UPSTREAM_UNAVAILABLE', '上游 stdio 连接已启动或关闭');
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd, env: this.options.env, shell: false,
      detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;
    this.#exited = new Promise(resolve => child.once('close', () => { resolve(); this.#notifyClose(); void this.close(); }));
    // An upstream must never pollute protocol stdout or leak configuration through stderr.
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => this.#read(chunk));
    const fail = (): void => { this.onerror?.(new AppError('MCP_UPSTREAM_UNAVAILABLE', '上游 stdio 连接失败')); void this.close(); };
    child.stdin.on('error', fail); child.stdout.on('error', fail); child.stderr.on('error', fail);
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', () => { reject(new AppError('MCP_UPSTREAM_UNAVAILABLE', '无法启动上游 MCP 进程')); fail(); });
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const child = this.#child;
    if (!child || this.#closed || this.#closing) throw new AppError('MCP_UPSTREAM_UNAVAILABLE', '上游 stdio 连接不可用');
    const text = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(text) > MAX_UPSTREAM_MESSAGE_BYTES) throw new AppError('OUTPUT_LIMIT_EXCEEDED', '上游 MCP 请求超过大小限制');
    await new Promise<void>((resolve, reject) => child.stdin.write(text, error => error ? reject(new AppError('MCP_UPSTREAM_UNAVAILABLE', '无法向上游发送请求')) : resolve()));
  }

  close(): Promise<void> {
    this.#closing ??= Promise.resolve().then(() => this.#shutdown());
    return this.#closing;
  }

  async #shutdown(): Promise<void> {
    const child = this.#child;
    const pid = child?.pid;
    if (child && pid) {
      if (process.platform === 'win32') {
        await new Promise<void>(resolve => {
          const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { shell: false, stdio: 'ignore', windowsHide: true });
          killer.once('error', () => { child.kill(); resolve(); }); killer.once('exit', () => resolve());
        });
      } else {
        const kill = (signal: NodeJS.Signals): void => { try { process.kill(-pid, signal); } catch { if (child.exitCode === null) child.kill(signal); } };
        kill('SIGTERM');
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([this.#exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 500); })]);
        if (timer) clearTimeout(timer);
        // Also kill descendants if the launcher exited before its children did.
        kill('SIGKILL');
      }
    }
    child?.stdin.destroy(); child?.stdout.destroy(); child?.stderr.destroy();
    this.#buffer = Buffer.alloc(0);
    this.#notifyClose();
  }

  #notifyClose(): void { if (!this.#closed) { this.#closed = true; this.onclose?.(); } }

  #read(chunk: Buffer): void {
    if (this.#closed || this.#closing) return;
    try {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      let newline: number;
      while ((newline = this.#buffer.indexOf(10)) !== -1) {
        if (newline > MAX_UPSTREAM_MESSAGE_BYTES) throw new AppError('OUTPUT_LIMIT_EXCEEDED', '上游 stdio 消息超过大小限制');
        const line = this.#buffer.subarray(0, newline);
        this.#buffer = this.#buffer.subarray(newline + 1);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(line);
        if (/^[ \t\r]*$/u.test(text)) continue;
        const value: unknown = JSON.parse(text);
        const parsed = JSONRPCMessageSchema.safeParse(value);
        if (!parsed.success) throw new Error();
        this.onmessage?.(parsed.data);
      }
      if (this.#buffer.length > MAX_UPSTREAM_MESSAGE_BYTES) throw new AppError('OUTPUT_LIMIT_EXCEEDED', '上游 stdio 消息超过大小限制');
    } catch (error) {
      this.onerror?.(error instanceof AppError ? error : new AppError('MCP_UPSTREAM_FAILED', '上游 stdio 消息无效'));
      void this.close();
    }
  }
}
