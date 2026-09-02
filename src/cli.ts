#!/usr/bin/env node
import { access } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { basename } from 'node:path';
import { z } from 'zod/v4';
import { WorkspaceContext } from './workspace/workspace-context.js';
import { GitService } from './git/git-service.js';
import { AuditLogger, type LogLevel } from './security/audit-logger.js';
import { startHttpServer } from './transports/http-server.js';
import { startStdio } from './transports/stdio-server.js';
import { safeError } from './shared/errors.js';

const schema = z.object({ command: z.enum(['serve', 'doctor', 'config']), workspace: z.string().min(1), transport: z.enum(['http', 'stdio']).default('http'), host: z.string().default('127.0.0.1'), port: z.number().int().min(1).max(65535).default(8765), mcpPath: z.string().regex(/^\/[A-Za-z0-9/_-]*$/u).default('/mcp'), allowPublicBind: z.boolean().default(false), authToken: z.string().min(16).optional(), logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info'), auditLog: z.string().optional() });
type CliConfig = z.infer<typeof schema>;

export function parseArgs(argv: string[]): CliConfig {
  if (argv[0] === '--') argv = argv.slice(1);
  const command = argv[0]; const values: Record<string, unknown> = { command }; let positional: string | undefined;
  const mapping: Record<string, string> = { '--workspace': 'workspace', '--transport': 'transport', '--host': 'host', '--port': 'port', '--mcp-path': 'mcpPath', '--auth-token': 'authToken', '--log-level': 'logLevel', '--audit-log': 'auditLog' };
  for (let index = 1; index < argv.length; index++) { const arg = argv[index]; if (arg === '--allow-public-bind') { values['allowPublicBind'] = true; continue; } const key = arg ? mapping[arg] : undefined; if (key) { const value = argv[++index]; if (value === undefined) throw new Error(`${arg} 缺少值`); values[key] = key === 'port' ? Number(value) : value; } else if (arg?.startsWith('-')) throw new Error(`未知参数：${arg}`); else if (!positional) positional = arg; else throw new Error('只能指定一个 workspace'); }
  values['workspace'] ??= positional; values['authToken'] ??= process.env['LOCAL_CODE_MCP_TOKEN']; return schema.parse(values);
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2)); const workspace = await WorkspaceContext.create(config.workspace); const logger = new AuditLogger(config.transport, config.logLevel as LogLevel, config.auditLog);
  if (config.command === 'config') { process.stdout.write(`${JSON.stringify(publicConfig(config, workspace.name), null, 2)}\n`); return; }
  if (config.command === 'doctor') { process.stdout.write(`${JSON.stringify(await doctor(config, workspace), null, 2)}\n`); return; }
  if (config.transport === 'stdio') { await startStdio(workspace, logger); return; }
  const running = await startHttpServer(workspace, { host: config.host, port: config.port, mcpPath: config.mcpPath, allowPublicBind: config.allowPublicBind, ...(config.authToken ? { authToken: config.authToken } : {}) }, logger);
  process.stderr.write(`[local-code-mcp] HTTP ready ${running.url} (${workspace.name})\n`);
  const shutdown = (): void => { void running.close().finally(() => process.exit(0)); }; process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

function publicConfig(config: CliConfig, workspaceName: string): Record<string, unknown> { return { workspaceName, transport: config.transport, host: config.host, port: config.port, mcpPath: config.mcpPath, authenticationConfigured: Boolean(config.authToken), allowPublicBind: config.allowPublicBind, sensitiveFilesAllowed: false, readOnly: true }; }
async function doctor(config: CliConfig, workspace: WorkspaceContext): Promise<Record<string, unknown>> { const git = new GitService(workspace); const repository = await git.isRepository(); let branch: string | null = null; let head: string | null = null; if (repository) { const status = await git.status(); branch = status.branch; head = status.head; } return { ok: Number(process.versions.node.split('.')[0]) >= 20 && repository, node: { version: process.versions.node, supported: Number(process.versions.node.split('.')[0]) >= 20 }, git: { available: await executableAvailable('git'), repository, rootName: repository ? basename(workspace.root) : null, branch, head }, ripgrep: { available: await executableAvailable('rg') }, workspace: { exists: true, name: workspace.name }, ignoreFile: { exists: await fileExists(`${workspace.root}/.local-code-mcp-ignore`) }, http: { host: config.host, safeHost: ['127.0.0.1', 'localhost', '::1'].includes(config.host), port: config.port, portAvailable: await portAvailable(config.host, config.port), publicBindAllowed: config.allowPublicBind, authConfigured: Boolean(config.authToken), dangerousPublicConfiguration: !['127.0.0.1', 'localhost', '::1'].includes(config.host) && (!config.allowPublicBind || !config.authToken) }, sensitiveFilesAllowed: false } }
async function executableAvailable(name: string): Promise<boolean> { const paths = (process.env['PATH'] ?? '').split(':'); for (const directory of paths) try { await access(`${directory}/${name}`); return true; } catch { /* continue */ } return false; }
async function fileExists(file: string): Promise<boolean> { try { await access(file); return true; } catch { return false; } }
async function portAvailable(host: string, port: number): Promise<boolean> { return await new Promise(resolve => { const server = createNetServer(); server.once('error', () => resolve(false)); server.listen(port, host, () => server.close(() => resolve(true))); }); }

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main().catch(error => { const safe = safeError(error); process.stderr.write(`[${safe.code}] ${safe.message}\n`); process.exitCode = 1; });
