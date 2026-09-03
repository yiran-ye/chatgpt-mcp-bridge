import { access, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod/v4';
import { AppError } from '../shared/errors.js';
import type { CommandConfig } from './access.js';

const MAX_CONFIG_BYTES = 64 * 1024;
const commandSchema = z.object({
  description: z.string().min(1).max(200),
  executable: z.string().min(1).max(4096).refine(value => !value.includes('\0'), 'executable 含非法字符'),
  fixedArgs: z.array(z.string().max(4096).refine(value => !value.includes('\0'))).max(64).default([]),
  allowAdditionalArgs: z.boolean().default(false),
  forwardEnv: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)).max(32).default([]),
  timeoutMs: z.number().int().min(100).max(600_000).default(60_000),
  maxOutputBytes: z.number().int().min(1024).max(1024 * 1024).default(256 * 1024),
}).strict();
const configSchema = z.object({
  version: z.literal(1),
  commands: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u), commandSchema),
}).strict();

export function parseCommandConfig(value: unknown): CommandConfig {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success || Object.keys(parsed.data.commands).length === 0) throw new AppError('COMMAND_CONFIG_INVALID', '命令配置校验失败或没有命令');
  return parsed.data;
}

export function defaultCommandConfigPath(): string {
  return path.join(os.homedir(), '.chatgpt-mcp-bridge', 'config.json');
}

export async function loadCommandConfig(input?: string): Promise<CommandConfig> {
  const candidate = path.resolve(input ?? defaultCommandConfigPath());
  let canonical: string;
  try { canonical = await realpath(candidate); } catch { throw new AppError('COMMAND_CONFIG_INVALID', '命令配置文件不存在'); }
  const info = await access(canonical).then(() => readFile(canonical)).catch(() => undefined);
  if (!info) throw new AppError('COMMAND_CONFIG_INVALID', '无法读取命令配置文件');
  if (info.byteLength > MAX_CONFIG_BYTES) throw new AppError('COMMAND_CONFIG_INVALID', '命令配置文件超过 64 KiB');
  let value: unknown;
  try { value = JSON.parse(info.toString('utf8')) as unknown; } catch { throw new AppError('COMMAND_CONFIG_INVALID', '命令配置不是有效 JSON'); }
  return parseCommandConfig(value);
}
