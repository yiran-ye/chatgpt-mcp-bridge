import { readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod/v4';
import { AppError } from '../shared/errors.js';
import { IgnorePolicy } from '../workspace/ignore-policy.js';
import { PathPolicy, type ResolvedPath } from '../workspace/path-policy.js';
import type { WorkspaceContext } from '../workspace/workspace-context.js';
import type { CommandConfig } from './access.js';

const MAX_CONFIG_BYTES = 64 * 1024;
const PROJECT_CONFIG_PATH = '.chatgpt-mcp-bridge/config.json';
const configPathSchema = z.string().min(1).max(4096).refine(value => !value.includes('\0'));
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

export type CommandConfigSource = 'explicit' | 'project' | 'global';
export interface CommandConfigResolution { path: string; source: CommandConfigSource; exists: boolean }

export async function resolveCommandConfigPath(input?: string, workspace?: WorkspaceContext): Promise<CommandConfigResolution> {
  if (input !== undefined) {
    const parsed = configPathSchema.safeParse(input);
    if (!parsed.success) throw new AppError('COMMAND_CONFIG_INVALID', '命令配置路径无效');
    return await resolveStandaloneConfig(parsed.data, 'explicit');
  }
  if (workspace) {
    try {
      const project = await workspace.paths.resolve(PROJECT_CONFIG_PATH, { allowIgnored: true, allowBridgeConfig: true });
      return { path: project.absolute, source: 'project', exists: true };
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'FILE_NOT_FOUND') throw error;
    }
  }
  return await resolveStandaloneConfig(defaultCommandConfigPath(), 'global');
}

export async function loadCommandConfig(input?: string, workspace?: WorkspaceContext): Promise<CommandConfig> {
  const resolution = await resolveCommandConfigPath(input, workspace);
  if (!resolution.exists) throw new AppError('COMMAND_CONFIG_INVALID', `命令配置文件不存在：${resolution.path}`);
  const info = await readFile(resolution.path).catch(() => undefined);
  if (!info) throw new AppError('COMMAND_CONFIG_INVALID', '无法读取命令配置文件');
  if (info.byteLength > MAX_CONFIG_BYTES) throw new AppError('COMMAND_CONFIG_INVALID', '命令配置文件超过 64 KiB');
  let value: unknown;
  try { value = JSON.parse(info.toString('utf8')) as unknown; } catch { throw new AppError('COMMAND_CONFIG_INVALID', '命令配置不是有效 JSON'); }
  return parseCommandConfig(value);
}

async function resolveStandaloneConfig(input: string, source: 'explicit' | 'global'): Promise<CommandConfigResolution> {
  const candidate = path.resolve(input); const parentInput = path.dirname(candidate); let parent: string;
  try { parent = await realpath(parentInput); } catch { return { path: candidate, source, exists: false }; }
  const policy = new PathPolicy(parent, await IgnorePolicy.create(parent)); let resolved: ResolvedPath;
  try { resolved = await policy.resolve(path.basename(candidate), { allowIgnored: true, allowBridgeConfig: true }); }
  catch (error) { if (error instanceof AppError && error.code === 'FILE_NOT_FOUND') return { path: candidate, source, exists: false }; throw error; }
  return { path: resolved.absolute, source, exists: true };
}
