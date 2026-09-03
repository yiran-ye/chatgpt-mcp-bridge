#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';
import { WorkspaceContext } from './workspace/workspace-context.js';
import { GitService } from './git/git-service.js';
import { AuditLogger, type LogLevel } from './security/audit-logger.js';
import { startHttpServer } from './transports/http-server.js';
import { startStdio } from './transports/stdio-server.js';
import { AppError, safeError } from './shared/errors.js';
import { PACKAGE_VERSION } from './shared/version.js';
import { loadCommandConfig, resolveCommandConfigPath, type CommandConfigResolution } from './runtime/command-config.js';
import type { AccessMode, BridgeOptions } from './runtime/access.js';

const schema = z.object({ command: z.enum(['serve', 'doctor', 'config']), workspace: z.string().min(1), transport: z.enum(['http', 'stdio']).default('http'), host: z.string().default('127.0.0.1'), port: z.number().int().min(1).max(65535).default(8765), mcpPath: z.string().regex(/^\/[A-Za-z0-9/_-]*$/u).default('/mcp'), allowPublicBind: z.boolean().default(false), authToken: z.string().min(16).optional(), logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info'), auditLog: z.string().optional(), access: z.enum(['read-only', 'workspace-write', 'command-exec']).default('read-only'), configPath: z.string().min(1).optional() }).strict();
const globalOptionSchema = z.tuple([z.enum(['--help', '--version'])]);
const argvSchema = z.array(z.string().max(4096).refine(value => !value.includes('\0'))).max(128);
type CliConfig = z.infer<typeof schema>;

export const HELP_TEXT = `chatgpt-mcp-bridge ${PACKAGE_VERSION}（缩写：cmb）

用法:
  chatgpt-mcp-bridge <command> [workspace] [options]
  cmb <command> [workspace] [options]

命令:
  serve    启动 MCP 服务
  doctor   检查配置和运行环境
  config   显示当前配置

全局选项:
  --help       显示帮助信息
  --version    显示版本号

常用选项:
  --workspace <path>          工作区路径
  --transport <http|stdio>    传输方式（默认: http）
  --access <mode>             read-only、workspace-write 或 command-exec
  --config <path>             命令配置文件
                              项目配置优先于 ~/.chatgpt-mcp-bridge/config.json
  --host <host>               HTTP 监听地址
  --port <port>               HTTP 监听端口
  --mcp-path <path>           MCP HTTP 路径（默认: /mcp）
  --allow-public-bind         允许监听非本机地址
  --auth-token <token>        HTTP Bearer Token
  --audit-log <path>          审计日志路径
  --log-level <level>         日志级别

示例:
  chatgpt-mcp-bridge serve /path/to/project
  cmb serve /path/to/project
  chatgpt-mcp-bridge doctor --workspace /path/to/project
`;

export function globalOptionOutput(argv: string[]): string | undefined {
  const parsed = globalOptionSchema.safeParse(argv);
  if (!parsed.success) return undefined;
  return parsed.data[0] === '--version' ? `${PACKAGE_VERSION}\n` : HELP_TEXT;
}

export function parseArgs(argv: string[]): CliConfig {
  const validatedArgv = argvSchema.safeParse(argv);
  if (!validatedArgv.success) throw new AppError('INVALID_INPUT', 'CLI 参数数量过多或包含非法内容');
  argv = validatedArgv.data;
  if (argv[0] === '--') argv = argv.slice(1);
  const command = argv[0]; const values: Record<string, unknown> = { command }; let positional: string | undefined;
  const mapping: Record<string, string> = { '--workspace': 'workspace', '--transport': 'transport', '--host': 'host', '--port': 'port', '--mcp-path': 'mcpPath', '--auth-token': 'authToken', '--log-level': 'logLevel', '--audit-log': 'auditLog', '--access': 'access', '--config': 'configPath' };
  for (let index = 1; index < argv.length; index++) { const arg = argv[index]; if (arg === '--allow-public-bind') { values['allowPublicBind'] = true; continue; } const key = arg ? mapping[arg] : undefined; if (key) { const value = argv[++index]; if (value === undefined) throw new AppError('INVALID_INPUT', `${arg} 缺少值`); values[key] = key === 'port' ? Number(value) : value; } else if (arg?.startsWith('-')) throw new AppError('INVALID_INPUT', `未知参数：${arg}`); else if (!positional) positional = arg; else throw new AppError('INVALID_INPUT', '只能指定一个 workspace'); }
  values['workspace'] ??= positional; values['authToken'] ??= process.env['CHATGPT_MCP_BRIDGE_TOKEN'];
  const parsed = schema.safeParse(values);
  if (!parsed.success) throw new AppError('INVALID_INPUT', cliValidationMessage(parsed.error));
  return parsed.data;
}

function cliValidationMessage(error: z.ZodError): string {
  const issue = error.issues[0]; const field = issue?.path[0];
  if (field === 'command') return '缺少或无法识别命令；可用命令：serve、doctor、config';
  if (field === 'workspace') return '缺少 workspace；请提供工作区路径，例如：chatgpt-mcp-bridge config .';
  const labels: Record<string, string> = { transport: '--transport', host: '--host', port: '--port', mcpPath: '--mcp-path', authToken: '--auth-token', logLevel: '--log-level', auditLog: '--audit-log', access: '--access', configPath: '--config' };
  return `参数 ${labels[String(field)] ?? String(field ?? '输入')} 的值无效`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2); const globalOutput = globalOptionOutput(argv);
  if (globalOutput !== undefined) { process.stdout.write(globalOutput); return; }
  const config = parseArgs(argv); const workspace = await WorkspaceContext.create(config.workspace); const logger = new AuditLogger(config.transport, config.logLevel as LogLevel, config.auditLog);
  const needsConfigResolution = config.command !== 'serve' || config.access === 'command-exec';
  const configResolution = needsConfigResolution ? await resolveCommandConfigPath(config.configPath, workspace) : undefined;
  const commandConfig = config.access === 'command-exec' ? await loadCommandConfig(config.configPath, workspace) : undefined;
  const bridgeOptions: BridgeOptions = { access: config.access as AccessMode, ...(commandConfig ? { commandConfig } : {}) };
  if (config.command === 'config' && configResolution) { process.stdout.write(`${JSON.stringify(publicConfig(config, workspace.name, configResolution, commandConfig ? Object.keys(commandConfig.commands) : []), null, 2)}\n`); return; }
  if (config.command === 'doctor' && configResolution) { process.stdout.write(`${JSON.stringify(await doctor(config, workspace, configResolution, commandConfig ? Object.keys(commandConfig.commands) : []), null, 2)}\n`); return; }
  if (config.transport === 'stdio') { await startStdio(workspace, logger, bridgeOptions); return; }
  const running = await startHttpServer(workspace, { host: config.host, port: config.port, mcpPath: config.mcpPath, allowPublicBind: config.allowPublicBind, ...(config.authToken ? { authToken: config.authToken } : {}) }, logger, bridgeOptions);
  process.stderr.write(`[chatgpt-mcp-bridge] HTTP ready ${running.url} (${workspace.name})\n`);
  const shutdown = (): void => { void running.close().finally(() => process.exit(0)); }; process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

function publicConfig(config: CliConfig, workspaceName: string, resolution: CommandConfigResolution, commandIds: string[]): Record<string, unknown> { return { workspaceName, transport: config.transport, host: config.host, port: config.port, mcpPath: config.mcpPath, access: config.access, configPath: resolution.path, configSource: resolution.source, configExists: resolution.exists, commandIds, authenticationConfigured: Boolean(config.authToken), allowPublicBind: config.allowPublicBind, sensitiveFilesAllowed: false, readOnly: config.access === 'read-only' }; }
async function doctor(config: CliConfig, workspace: WorkspaceContext, resolution: CommandConfigResolution, commandIds: string[]): Promise<Record<string, unknown>> { const git = new GitService(workspace); const repository = await git.isRepository(); let branch: string | null = null; let head: string | null = null; if (repository) { const status = await git.status(); branch = status.branch; head = status.head; } const safeHost = ['127.0.0.1', 'localhost', '::1'].includes(config.host); const writableHttpValid = config.transport !== 'http' || config.access === 'read-only' || (safeHost && Boolean(config.authToken && config.authToken.length >= 32)); return { ok: Number(process.versions.node.split('.')[0]) >= 20 && repository && writableHttpValid, node: { version: process.versions.node, supported: Number(process.versions.node.split('.')[0]) >= 20 }, git: { available: await executableAvailable('git'), repository, rootName: repository ? basename(workspace.root) : null, branch, head }, ripgrep: { available: await executableAvailable('rg') }, workspace: { exists: true, name: workspace.name }, access: { mode: config.access, configPath: resolution.path, configSource: resolution.source, configExists: resolution.exists, commandIds }, ignoreFile: { exists: await fileExists(`${workspace.root}/.chatgpt-mcp-bridge-ignore`) }, http: { host: config.host, safeHost, port: config.port, portAvailable: await portAvailable(config.host, config.port), publicBindAllowed: config.allowPublicBind, authConfigured: Boolean(config.authToken), writableConfigurationValid: writableHttpValid, dangerousPublicConfiguration: !safeHost && (!config.allowPublicBind || !config.authToken) }, sensitiveFilesAllowed: false } }
async function executableAvailable(name: string): Promise<boolean> { const paths = (process.env['PATH'] ?? '').split(':'); for (const directory of paths) try { await access(`${directory}/${name}`); return true; } catch { /* continue */ } return false; }
async function fileExists(file: string): Promise<boolean> { try { await access(file); return true; } catch { return false; } }
async function portAvailable(host: string, port: number): Promise<boolean> { return await new Promise(resolve => { const server = createNetServer(); server.once('error', () => resolve(false)); server.listen(port, host, () => server.close(() => resolve(true))); }); }

export function isMainModule(argvPath: string | undefined, moduleUrl = import.meta.url): boolean {
  if (!argvPath) return false;
  try { return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl)); } catch { return false; }
}

if (isMainModule(process.argv[1])) main().catch(error => { const safe = safeError(error); process.stderr.write(`[${safe.code}] ${safe.message}\n`); process.exitCode = 1; });
