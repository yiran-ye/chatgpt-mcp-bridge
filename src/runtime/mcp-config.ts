import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import { AppError } from '../shared/errors.js';
import type { WorkspaceContext } from '../workspace/workspace-context.js';

export const MCP_CONFIG_PATH = '.chatgpt-mcp-bridge/mcp.json';
export const MAX_MCP_CONFIG_BYTES = 64 * 1024;
const text = z.string().max(4096).refine(value => !value.includes('\0'));
const environment = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), text);
const headers = z.record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u), text.refine(value => !/[\r\n]/u.test(value)));
const executable = text.min(1).refine(value => !path.isAbsolute(value) && !/^[A-Za-z]:|^\\/u.test(value), '仅允许 PATH 程序名或工作区相对路径');
const definition = z.discriminatedUnion('transport', [
  z.object({ transport: z.literal('stdio'), command: executable, args: z.array(text).max(64).default([]), cwd: text.min(1).default('.'), env: environment.default({}) }).strict(),
  z.object({ transport: z.literal('http'), url: z.url().max(4096).refine(value => !value.includes('\0')).refine(value => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash;
  }), headers: headers.default({}) }).strict(),
]);
const configSchema = z.object({
  version: z.literal(1),
  mcpServers: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/u), definition).refine(value => Object.keys(value).length <= 16),
}).strict();

export type McpConfig = z.infer<typeof configSchema>;
export type McpServerDefinition = McpConfig['mcpServers'][string];
export interface McpConfigSummary { path: string; exists: boolean; servers: Array<{ id: string; transport: 'stdio' | 'http' }> }
export interface PreparedMcpServer { id: string; definition: McpServerDefinition; cwd?: string; command?: string }

export function parseMcpConfig(value: unknown): McpConfig {
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_MCP_CONFIG_BYTES) throw new Error();
    const parsed = configSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  } catch { /* Never include configuration values in diagnostics. */ }
  throw new AppError('MCP_CONFIG_INVALID', 'MCP 配置无效或超过 64 KiB');
}

export async function loadMcpConfig(workspace: WorkspaceContext): Promise<McpConfig> {
  const target = await workspace.paths.resolve(MCP_CONFIG_PATH, { allowBridgeConfig: true, allowIgnored: true });
  const file = await open(target.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.dev !== target.stat.dev || info.ino !== target.stat.ino || info.size > MAX_MCP_CONFIG_BYTES) throw new AppError('MCP_CONFIG_INVALID', 'MCP 配置不是安全的普通文件或超过 64 KiB');
    const buffer = Buffer.alloc(MAX_MCP_CONFIG_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_MCP_CONFIG_BYTES) throw new AppError('MCP_CONFIG_INVALID', 'MCP 配置超过 64 KiB');
    try { return parseMcpConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size))) as unknown); }
    catch { throw new AppError('MCP_CONFIG_INVALID', 'MCP 配置不是有效的 UTF-8 JSON 或不符合配置格式'); }
  } finally { await file.close(); }
}

/** Only an absent configuration is optional; failures in its referenced paths are errors. */
export async function loadOptionalMcpConfig(workspace: WorkspaceContext): Promise<McpConfig | undefined> {
  try { return await loadMcpConfig(workspace); }
  catch (error) {
    if (error instanceof AppError && error.code === 'FILE_NOT_FOUND') return undefined;
    throw error;
  }
}

/** Validates substitutions without starting processes or making network requests. */
export async function inspectMcpConfig(workspace: WorkspaceContext): Promise<McpConfigSummary> {
  const loaded = await loadOptionalMcpConfig(workspace);
  if (!loaded) return { path: MCP_CONFIG_PATH, exists: false, servers: [] };
  const config = resolveMcpEnvironment(loaded);
  await prepareMcpConfig(workspace, config);
  return { path: MCP_CONFIG_PATH, exists: true, servers: Object.entries(config.mcpServers).map(([id, server]) => ({ id, transport: server.transport })) };
}

/** No process or network side effects: all paths are checked before any server is started. */
export async function prepareMcpConfig(workspace: WorkspaceContext, config: McpConfig): Promise<PreparedMcpServer[]> {
  return await Promise.all(Object.entries(config.mcpServers).map(async ([id, definition]) => {
    if (definition.transport === 'http') return { id, definition };
    const cwd = await workspace.paths.resolve(definition.cwd, { allowDirectory: true });
    if (!cwd.stat.isDirectory()) throw new AppError('MCP_CONFIG_INVALID', 'MCP cwd 必须是工作区内的目录');
    const command = /[\\/]/u.test(definition.command) || ['.', '..'].includes(definition.command)
      ? (await workspace.paths.resolve(definition.command)).absolute : definition.command;
    return { id, definition, cwd: cwd.absolute, command };
  }));
}

export function resolveMcpEnvironment(config: McpConfig, env: NodeJS.ProcessEnv = process.env): McpConfig {
  const expand = (values: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_match, name: string) => {
    const replacement = env[name];
    if (replacement === undefined) throw new AppError('MCP_CONFIG_INVALID', 'MCP 配置引用的环境变量未设置');
    return replacement;
  })]));
  // Revalidate after expansion, including header CR/LF and length limits.
  return parseMcpConfig({ version: 1, mcpServers: Object.fromEntries(Object.entries(config.mcpServers).map(([id, server]) => [id, server.transport === 'stdio' ? { ...server, env: expand(server.env) } : { ...server, headers: expand(server.headers) }])) });
}
