import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolResultSchema, ListToolsResultSchema, McpError, ErrorCode as RpcErrorCode, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { JsonSchemaValidator, JsonSchemaType } from '@modelcontextprotocol/sdk/validation';
import { parseMcpConfig, loadMcpConfig, resolveMcpEnvironment, prepareMcpConfig, type PreparedMcpServer } from '../runtime/mcp-config.js';
import type { WorkspaceContext } from '../workspace/workspace-context.js';
import { PathPolicy } from '../workspace/path-policy.js';
import { IgnorePolicy } from '../workspace/ignore-policy.js';
import { AppError, type ErrorCode } from '../shared/errors.js';
import { PACKAGE_VERSION } from '../shared/version.js';
import { COMMAND_ANNOTATIONS } from '../shared/constants.js';
import { ManagedStdioClientTransport } from './stdio-client-transport.js';
import { upstreamFetch } from './http-client-fetch.js';
import { McpSchemaValidator } from './schema-validator.js';

export const MAX_MCP_RESULT_BYTES = 1024 * 1024;
const inputSchema = z.record(z.string(), z.unknown());
interface Upstream {
  id: string; type: 'stdio' | 'http'; status: 'connecting' | 'ready' | 'error' | 'closed';
  toolCount: number; errorCode?: ErrorCode; client: Client; transport: Transport;
  controller: AbortController; closing?: Promise<void>;
}
interface ProxyTool {
  definition: Tool; originalName: string; upstream: Upstream;
  validateInput: JsonSchemaValidator<unknown>; validateOutput?: JsonSchemaValidator<unknown>;
}
export interface McpUpstreamSummary { id: string; transport: 'stdio' | 'http'; status: Upstream['status']; toolCount: number; errorCode?: ErrorCode }

/** Created explicitly once per Bridge service, never once per HTTP request. */
export class McpProxyRuntime {
  readonly #upstreams: Upstream[] = [];
  readonly #tools = new Map<string, Map<string, ProxyTool>>();
  readonly #shutdown = new AbortController();
  #closing: Promise<void> | undefined;
  #active = 0;
  private constructor(readonly workspaceRoot: string) {}

  static async create(workspace: WorkspaceContext, value?: unknown, signal?: AbortSignal): Promise<McpProxyRuntime> {
    const config = resolveMcpEnvironment(value === undefined ? await loadMcpConfig(workspace) : parseMcpConfig(value));
    // Check all filesystem boundaries before starting any upstream.
    const prepared = await prepareMcpConfig(workspace, config);
    if (signal?.aborted) throw new AppError('TIMEOUT', 'MCP 代理启动已取消');
    const runtime = new McpProxyRuntime(workspace.root);
    const abort = (): void => { void runtime.close(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const groups = await Promise.all(prepared.map(server => runtime.#connect(server)));
      for (const tool of groups.flat()) {
        let catalog = runtime.#tools.get(tool.upstream.id);
        if (!catalog) { catalog = new Map(); runtime.#tools.set(tool.upstream.id, catalog); }
        catalog.set(tool.originalName, tool);
      }
      if (runtime.#shutdown.signal.aborted) throw new AppError('TIMEOUT', 'MCP 代理启动已取消');
      return runtime;
    } catch (error) { await runtime.close(); throw error; }
    finally { signal?.removeEventListener('abort', abort); }
  }

  listTools(serverId: string): Tool[] {
    const server = this.#upstreams.find(upstream => upstream.id === serverId);
    if (!server || server.status !== 'ready' || this.#closing) throw new AppError('MCP_UPSTREAM_UNAVAILABLE', '上游 MCP 服务不可用；修复配置或服务后重启 Bridge');
    return Array.from(this.#tools.get(serverId)?.values() ?? [], tool => structuredClone(tool.definition));
  }
  summaries(): McpUpstreamSummary[] { return this.#upstreams.map(server => ({ id: server.id, transport: server.type, status: server.status, toolCount: server.toolCount, ...(server.errorCode ? { errorCode: server.errorCode } : {}) })); }

  async callTool(serverId: string, toolName: string, args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const tool = this.#tools.get(serverId)?.get(toolName);
    if (!tool || this.#closing !== undefined || tool.upstream.status !== 'ready') throw new AppError('MCP_UPSTREAM_UNAVAILABLE', '上游 MCP 工具不可用；修复配置或服务后重启 Bridge');
    const parsed = inputSchema.safeParse(args ?? {});
    if (!parsed.success) throw new AppError('INVALID_INPUT', '调用参数必须是 JSON 对象');
    if (Buffer.byteLength(JSON.stringify(parsed.data)) > MAX_MCP_RESULT_BYTES) throw new AppError('OUTPUT_LIMIT_EXCEEDED', '上游工具参数超过 1 MiB');
    if (!tool.validateInput(parsed.data).valid) throw new AppError('INVALID_INPUT', '调用参数不符合上游工具要求');
    if (this.#active >= 32) throw new AppError('MCP_UPSTREAM_FAILED', '上游 MCP 调用并发已达上限');
    const combined = AbortSignal.any([this.#shutdown.signal, tool.upstream.controller.signal, ...(signal ? [signal] : [])]);
    this.#active++;
    try {
      const result = await tool.upstream.client.request({ method: 'tools/call', params: { name: tool.originalName, arguments: parsed.data } }, CallToolResultSchema, { signal: combined, timeout: 30_000, maxTotalTimeout: 30_000 });
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_MCP_RESULT_BYTES) throw new AppError('OUTPUT_LIMIT_EXCEEDED', '上游工具结果超过 1 MiB');
      if (!result.isError && tool.validateOutput && !tool.validateOutput(result.structuredContent).valid) throw new AppError('MCP_SCHEMA_INVALID', '上游工具结果不符合声明的输出结构');
      return result;
    } catch (error) {
      if (signal?.aborted || this.#shutdown.signal.aborted) throw new AppError('TIMEOUT', '上游 MCP 调用超时或已取消');
      if (tool.upstream.errorCode === 'OUTPUT_LIMIT_EXCEEDED') throw new AppError('OUTPUT_LIMIT_EXCEEDED', '上游 MCP 消息超过大小限制');
      if (tool.upstream.controller.signal.aborted) throw new AppError('MCP_UPSTREAM_UNAVAILABLE', '上游 MCP 连接已关闭');
      if (error instanceof McpError && error.code === (RpcErrorCode.RequestTimeout as number)) throw new AppError('TIMEOUT', '上游 MCP 调用超时');
      if (error instanceof AppError) throw error;
      throw new AppError('MCP_UPSTREAM_FAILED', '上游 MCP 调用失败');
    } finally { this.#active--; }
  }

  close(): Promise<void> {
    if (!this.#closing) {
      this.#shutdown.abort();
      this.#closing = Promise.all(this.#upstreams.map(async server => { server.status = 'closed'; await closeUpstream(server); })).then(() => undefined);
    }
    return this.#closing;
  }

  async #connect(prepared: PreparedMcpServer): Promise<ProxyTool[]> {
    const { id, definition } = prepared; const controller = new AbortController();
    const client = new Client({ name: 'chatgpt-mcp-bridge-proxy', version: PACKAGE_VERSION }, { capabilities: {} });
    // Executables resolved from PATH are trusted launch configuration, not MCP input.
    let transport: Transport;
    let launch: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } | undefined;
    if (definition.transport === 'stdio') {
      if (!prepared.command || !prepared.cwd) throw new AppError('MCP_CONFIG_INVALID', '上游 MCP 启动路径未经校验');
      launch = { command: prepared.command, args: definition.args, cwd: prepared.cwd, env: childEnvironment(definition.env) };
      transport = new ManagedStdioClientTransport(launch);
    } else {
      // SDK getter sessionId has a wider optional type under exactOptionalPropertyTypes.
      transport = new StreamableHTTPClientTransport(new URL(definition.url), {
        requestInit: { headers: definition.headers, redirect: 'error' }, fetch: upstreamFetch(new URL(definition.url), controller.signal),
        reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 30_000, initialReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1.5 },
      }) as unknown as Transport;
    }
    const server: Upstream = { id, type: definition.transport, status: 'connecting', toolCount: 0, client, transport, controller };
    this.#upstreams.push(server);
    client.onclose = () => { if (server.status !== 'closed') { server.status = 'error'; server.errorCode ??= 'MCP_UPSTREAM_UNAVAILABLE'; } };
    client.onerror = error => { if (server.status !== 'closed') { server.status = 'error'; server.errorCode ??= error instanceof AppError ? error.code : 'MCP_UPSTREAM_FAILED'; void closeUpstream(server); } };
    const timer = setTimeout(() => controller.abort(), 10_000);
    const abort = (): void => { void closeUpstream(server); }; controller.signal.addEventListener('abort', abort, { once: true });
    try {
      if (launch && definition.transport === 'stdio') launch.command = await resolveExecutable(launch.command, definition.env);
      controller.signal.throwIfAborted();
      await client.connect(transport, { signal: controller.signal, timeout: 10_000 });
      const tools: ProxyTool[] = []; const seen = new Set<string>(); const cursors = new Set<string>();
      const validator = new McpSchemaValidator(); let cursor: string | undefined; let metadataBytes = 0;
      do {
        const page = await client.request({ method: 'tools/list', params: cursor ? { cursor } : {} }, ListToolsResultSchema, { signal: controller.signal, timeout: 10_000 });
        for (const tool of page.tools) {
          metadataBytes += Buffer.byteLength(JSON.stringify(tool));
          if (metadataBytes > MAX_MCP_RESULT_BYTES) throw new AppError('MCP_SCHEMA_INVALID', '上游工具目录超过 1 MiB');
          if (!tool.name || tool.name.length > 256 || seen.has(tool.name) || tools.length >= 256 || tool.execution?.taskSupport === 'required') throw new AppError('MCP_SCHEMA_INVALID', '上游工具目录无效、过大或要求不受支持的任务能力');
          seen.add(tool.name);
          const validateInput = validator.getValidator(tool.inputSchema as JsonSchemaType);
          const validateOutput = tool.outputSchema ? validator.getValidator(tool.outputSchema as JsonSchemaType) : undefined;
          const toolDefinition: Tool = { name: tool.name, inputSchema: tool.inputSchema, ...(tool.title ? { title: tool.title } : {}), ...(tool.description ? { description: tool.description } : {}), ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}), annotations: { ...COMMAND_ANNOTATIONS, ...tool.annotations } };
          tools.push({ definition: toolDefinition, originalName: tool.name, upstream: server, validateInput, ...(validateOutput ? { validateOutput } : {}) });
        }
        cursor = page.nextCursor;
        if (cursor !== undefined && (cursors.has(cursor) || cursors.size >= 32 || cursor.length > 4096)) throw new AppError('MCP_SCHEMA_INVALID', '上游工具分页游标无效');
        if (cursor !== undefined) cursors.add(cursor);
      } while (cursor !== undefined);
      if (controller.signal.aborted || server.closing) throw new AppError('MCP_UPSTREAM_UNAVAILABLE', '上游连接已关闭');
      server.status = 'ready'; server.toolCount = tools.length;
      return tools;
    } catch (error) {
      server.status = 'error'; server.errorCode = error instanceof AppError ? error.code : server.errorCode ?? 'MCP_UPSTREAM_UNAVAILABLE';
      await closeUpstream(server);
      return [];
    } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); }
  }
}

function childEnvironment(configured: Record<string, string>): NodeJS.ProcessEnv {
  const names = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SystemRoot', 'SystemDrive', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE'];
  return { ...Object.fromEntries(names.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]])), ...configured };
}

async function resolveExecutable(command: string, env: Record<string, string>): Promise<string> {
  if (path.isAbsolute(command)) { await access(command, constants.X_OK); return command; }
  const extensions = process.platform === 'win32' ? ['', '.exe', '.com'] : [''];
  for (const directory of (env['PATH'] ?? process.env['PATH'] ?? '').split(path.delimiter).filter(value => path.isAbsolute(value))) {
    for (const extension of extensions) {
      try {
        const canonical = await realpath(path.join(directory, `${command}${extension}`));
        const parent = path.dirname(canonical);
        const policy = new PathPolicy(parent, await IgnorePolicy.create(parent));
        const resolved = await policy.resolve(path.basename(canonical), { allowIgnored: true });
        await access(resolved.absolute, constants.X_OK); return resolved.absolute;
      } catch { /* Try the next PATH entry without exposing it. */ }
    }
  }
  throw new AppError('MCP_UPSTREAM_UNAVAILABLE', '无法在 PATH 中找到上游 MCP 程序');
}

function closeUpstream(server: Upstream): Promise<void> {
  server.closing ??= Promise.resolve().then(async () => {
    if (server.transport instanceof StreamableHTTPClientTransport && server.transport.sessionId && !server.controller.signal.aborted) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([server.transport.terminateSession().catch(() => undefined), new Promise<void>(resolve => { timer = setTimeout(resolve, 500); })]);
      if (timer) clearTimeout(timer);
    }
    server.controller.abort();
    await server.client.close().catch(() => undefined);
    await server.transport.close().catch(() => undefined);
  });
  return server.closing;
}
