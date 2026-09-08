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
import { startHttpServer, assertHttpSecurity } from './transports/http-server.js';
import { startStdio } from './transports/stdio-server.js';
import { AppError, safeError } from './shared/errors.js';
import { PACKAGE_VERSION } from './shared/version.js';
import { loadCommandConfig, resolveCommandConfigPath, type CommandConfigResolution } from './runtime/command-config.js';
import type { AccessMode, BridgeOptions } from './runtime/access.js';
import { McpProxyRuntime } from './mcp/proxy-runtime.js';
import { inspectMcpConfig, loadOptionalMcpConfig, type McpConfigSummary } from './runtime/mcp-config.js';

const schema = z.object({ command: z.enum(['serve', 'doctor', 'config']), workspace: z.string().min(1), transport: z.enum(['http', 'stdio']).default('http'), host: z.string().default('127.0.0.1'), port: z.number().int().min(1).max(65535).default(8765), mcpPath: z.string().regex(/^\/[A-Za-z0-9/_-]*$/u).default('/mcp'), allowPublicBind: z.boolean().default(false), authToken: z.string().min(16).optional(), logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info'), auditLog: z.string().optional(), access: z.enum(['read-only', 'workspace-write', 'command-exec', 'full-access']).default('read-only'), configPath: z.string().min(1).optional(), enableMcp: z.boolean().default(false) }).strict();
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
  --access <mode>             read-only、workspace-write、command-exec 或 full-access
  --config <path>             command-exec 命令配置文件
                              项目配置优先于 ~/.chatgpt-mcp-bridge/config.json
  --enable-mcp               兼容旧命令；已无需指定，项目 mcp.json 有配置即自动加载
                              配置授权上游全部工具；HTTP 需本机监听和强 Token
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
  for (let index = 1; index < argv.length; index++) { const arg = argv[index]; if (arg === '--allow-public-bind') { values['allowPublicBind'] = true; continue; } if (arg === '--enable-mcp') { values['enableMcp'] = true; continue; } const key = arg ? mapping[arg] : undefined; if (key) { const value = argv[++index]; if (value === undefined) throw new AppError('INVALID_INPUT', `${arg} 缺少值`); values[key] = key === 'port' ? Number(value) : value; } else if (arg?.startsWith('-')) throw new AppError('INVALID_INPUT', `未知参数：${arg}`); else if (!positional) positional = arg; else throw new AppError('INVALID_INPUT', '只能指定一个 workspace'); }
  values['workspace'] ??= positional; values['authToken'] ??= process.env['CHATGPT_MCP_BRIDGE_TOKEN'];
  const parsed = schema.safeParse(values);
  if (!parsed.success) throw new AppError('INVALID_INPUT', cliValidationMessage(parsed.error));
  if (parsed.data.access === 'full-access' && parsed.data.configPath !== undefined) throw new AppError('INVALID_INPUT', 'full-access 不使用 --config');
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
  const needsConfigResolution = config.access !== 'full-access' && (config.command !== 'serve' || config.access === 'command-exec');
  const configResolution = needsConfigResolution ? await resolveCommandConfigPath(config.configPath, workspace) : undefined;
  const commandConfig = config.access === 'command-exec' ? await loadCommandConfig(config.configPath, workspace) : undefined;
  const bridgeOptions: BridgeOptions = { access: config.access as AccessMode, ...(commandConfig ? { commandConfig } : {}) };
  const mcpSummary = config.command === 'serve' ? undefined : await inspectMcpConfig(workspace);
  if (config.command === 'config') { process.stdout.write(`${JSON.stringify(publicConfig(config, workspace.name, configResolution, commandConfig ? Object.keys(commandConfig.commands) : [], mcpSummary), null, 2)}\n`); return; }
  if (config.command === 'doctor') { process.stdout.write(`${JSON.stringify(await doctor(config, workspace, configResolution, commandConfig ? Object.keys(commandConfig.commands) : [], mcpSummary), null, 2)}\n`); return; }
  const httpOptions = { host: config.host, port: config.port, mcpPath: config.mcpPath, allowPublicBind: config.allowPublicBind, ...(config.authToken ? { authToken: config.authToken } : {}) };
  const mcpConfig = await loadOptionalMcpConfig(workspace);
  const mcpEnabled = Boolean(mcpConfig && Object.keys(mcpConfig.mcpServers).length);
  if (config.transport === 'http') assertHttpSecurity(httpOptions, config.access !== 'read-only' || mcpEnabled);
  const startup = new AbortController(); const interruptStartup = (): void => startup.abort();
  const ensureStartupActive = (): void => { if (startup.signal.aborted) throw new AppError('TIMEOUT', '服务启动已取消'); };
  process.once('SIGINT', interruptStartup); process.once('SIGTERM', interruptStartup);
  try {
    if (mcpEnabled) bridgeOptions.mcpProxy = await McpProxyRuntime.create(workspace, mcpConfig, startup.signal);
    ensureStartupActive();
    if (config.transport === 'stdio') { await startStdio(workspace, logger, bridgeOptions); return; }
    const running = await startHttpServer(workspace, httpOptions, logger, bridgeOptions);
    if (startup.signal.aborted) { await running.close(); throw new AppError('TIMEOUT', '服务启动已取消'); }
    process.stderr.write(`[chatgpt-mcp-bridge] HTTP ready ${running.url} (${workspace.name})\n`);
    const shutdown = (): void => { void running.close().finally(() => process.exit(0)); }; process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  } catch (error) { await bridgeOptions.mcpProxy?.close(); throw error; }
  finally { process.off('SIGINT', interruptStartup); process.off('SIGTERM', interruptStartup); }
}

function configDiagnostics(config: CliConfig, resolution: CommandConfigResolution | undefined): { configPath: string | null; configSource: CommandConfigResolution['source'] | null; configExists: boolean | null } { return config.access === 'full-access' ? { configPath: null, configSource: null, configExists: null } : { configPath: resolution?.path ?? null, configSource: resolution?.source ?? null, configExists: resolution?.exists ?? null }; }
function publicConfig(config: CliConfig, workspaceName: string, resolution: CommandConfigResolution | undefined, commandIds: string[], mcpSummary?: McpConfigSummary): Record<string, unknown> {
  const commandPolicy = config.access === 'full-access' ? 'unrestricted' : config.access === 'command-exec' ? 'allowlist' : 'none';
  const mcpEnabled = Boolean(mcpSummary?.servers.length);
  return {
    workspaceName, transport: config.transport, host: config.host, port: config.port, mcpPath: config.mcpPath,
    access: config.access, commandPolicy, ...configDiagnostics(config, resolution), commandIds,
    authenticationConfigured: Boolean(config.authToken), allowPublicBind: config.allowPublicBind,
    sensitiveFilesAllowed: mcpEnabled, readOnly: config.access === 'read-only' && !mcpEnabled,
    mcp: { enabled: mcpEnabled, ...mcpSummary, upstreamAccess: mcpEnabled ? 'all-tools' : 'disabled' },
  };
}
async function doctor(config: CliConfig, workspace: WorkspaceContext, resolution: CommandConfigResolution | undefined, commandIds: string[], mcpSummary?: McpConfigSummary): Promise<Record<string, unknown>> {
  const git = new GitService(workspace); const repository = await git.isRepository();
  let branch: string | null = null; let head: string | null = null;
  if (repository) { const status = await git.status(); branch = status.branch; head = status.head; }
  const mcpEnabled = Boolean(mcpSummary?.servers.length);
  const safeHost = ['127.0.0.1', 'localhost', '::1'].includes(config.host);
  const writableHttpValid = config.transport !== 'http' || (config.access === 'read-only' && !mcpEnabled) || (safeHost && Boolean(config.authToken && config.authToken.length >= 32));
  const commandPolicy = config.access === 'full-access' ? 'unrestricted' : config.access === 'command-exec' ? 'allowlist' : 'none';
  return {
    ok: Number(process.versions.node.split('.')[0]) >= 20 && repository && writableHttpValid && (!mcpEnabled || Boolean(mcpSummary?.exists)),
    node: { version: process.versions.node, supported: Number(process.versions.node.split('.')[0]) >= 20 },
    git: { available: await executableAvailable('git'), repository, rootName: repository ? basename(workspace.root) : null, branch, head },
    ripgrep: { available: await executableAvailable('rg') }, workspace: { exists: true, name: workspace.name },
    access: { mode: config.access, commandPolicy, ...configDiagnostics(config, resolution), commandIds },
    mcp: { enabled: mcpEnabled, ...mcpSummary, upstreamAccess: mcpEnabled ? 'all-tools' : 'disabled', connectivityChecked: false },
    ignoreFile: { exists: await fileExists(`${workspace.root}/.chatgpt-mcp-bridge-ignore`) },
    http: { host: config.host, safeHost, port: config.port, portAvailable: await portAvailable(config.host, config.port), publicBindAllowed: config.allowPublicBind, authConfigured: Boolean(config.authToken), writableConfigurationValid: writableHttpValid, dangerousPublicConfiguration: !safeHost && (mcpEnabled || !config.allowPublicBind || !config.authToken) },
    sensitiveFilesAllowed: mcpEnabled,
  };
}
async function executableAvailable(name: string): Promise<boolean> { const paths = (process.env['PATH'] ?? '').split(':'); for (const directory of paths) try { await access(`${directory}/${name}`); return true; } catch { /* continue */ } return false; }
async function fileExists(file: string): Promise<boolean> { try { await access(file); return true; } catch { return false; } }
async function portAvailable(host: string, port: number): Promise<boolean> { return await new Promise(resolve => { const server = createNetServer(); server.once('error', () => resolve(false)); server.listen(port, host, () => server.close(() => resolve(true))); }); }

export function isMainModule(argvPath: string | undefined, moduleUrl = import.meta.url): boolean {
  if (!argvPath) return false;
  try { return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl)); } catch { return false; }
}

if (isMainModule(process.argv[1])) main().catch(error => { const safe = safeError(error); process.stderr.write(`[${safe.code}] ${safe.message}\n`); process.exitCode = 1; });
