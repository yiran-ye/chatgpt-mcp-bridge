import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { WorkspaceContext } from '../workspace/workspace-context.js';
import type { BridgeOptions } from '../runtime/access.js';
import type { AuditLogger } from '../security/audit-logger.js';
import { AppError, safeError } from '../shared/errors.js';
import { requestDigest } from '../security/output-limiter.js';
import { MAX_MCP_RESULT_BYTES } from '../mcp/proxy-runtime.js';
import { registerMcpGateway } from './mcp-gateway.js';

type Shape = z.ZodRawShape | z.ZodType;
interface ToolExtra { signal: AbortSignal }
interface BuiltinConfig { title?: string; description?: string; inputSchema: Shape; outputSchema?: Shape; annotations?: Tool['annotations'] }
export interface BuiltinToolRegistrar { registerTool(name: string, config: BuiltinConfig, handler: (input: never, extra: ToolExtra) => Promise<CallToolResult>): void }
interface Entry { definition: Tool; invoke(args: unknown, extra: ToolExtra): Promise<CallToolResult> }

/** Publishes built-in tools and a configuration-independent upstream gateway. */
export class ToolCatalog implements BuiltinToolRegistrar {
  readonly #entries = new Map<string, Entry>();

  registerTool(name: string, config: BuiltinConfig, handler: (input: never, extra: ToolExtra) => Promise<CallToolResult>): void {
    const input = asSchema(config.inputSchema); const output = config.outputSchema ? asSchema(config.outputSchema) : undefined;
    this.#add({
      definition: {
        name, inputSchema: z.toJSONSchema(input, { io: 'input', target: 'draft-7' }) as Tool['inputSchema'],
        ...(config.title ? { title: config.title } : {}), ...(config.description ? { description: config.description } : {}),
        ...(config.annotations ? { annotations: config.annotations } : {}),
        ...(output ? { outputSchema: z.toJSONSchema(output, { io: 'output', target: 'draft-7' }) as NonNullable<Tool['outputSchema']> } : {}),
      },
      invoke: async (args, extra) => {
        const parsed = await input.safeParseAsync(args ?? {});
        if (!parsed.success) throw new AppError('INVALID_INPUT', '工具输入无效');
        const result = await handler(parsed.data as never, extra);
        if (output && !result.isError && !(await output.safeParseAsync(result.structuredContent)).success) throw new AppError('INTERNAL_ERROR', '工具输出不符合声明的结构');
        return result;
      },
    });
  }

  attach(server: McpServer, workspace: WorkspaceContext, options?: BridgeOptions, logger?: AuditLogger): void {
    registerMcpGateway(this, workspace, options?.mcpProxy, logger);
    const definitions = Array.from(this.#entries.values(), entry => entry.definition);
    const digest = requestDigest(definitions);
    server.server.registerCapabilities({ tools: { listChanged: false } });
    server.server.setRequestHandler(ListToolsRequestSchema, request => {
      const cursor = request.params?.cursor;
      const offset = cursor ? workspace.cursors.verify(cursor, 'tools/list', digest) : 0;
      const tools: Tool[] = []; let bytes = 128; let index = offset;
      while (index < definitions.length && tools.length < 100) {
        const tool = definitions[index]; if (!tool) break;
        const size = Buffer.byteLength(JSON.stringify(tool)) + 1;
        if (bytes + size > MAX_MCP_RESULT_BYTES) break;
        tools.push(tool); bytes += size; index++;
      }
      if (!tools.length && index < definitions.length) throw new AppError('OUTPUT_LIMIT_EXCEEDED', '工具定义超过大小限制');
      return { tools, ...(index < definitions.length ? { nextCursor: workspace.cursors.sign('tools/list', index, digest) } : {}) };
    });
    server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      try {
        if (request.params.task) throw new AppError('INVALID_INPUT', '此 Bridge 不支持 MCP 任务扩展');
        const entry = this.#entries.get(request.params.name);
        if (!entry) throw new AppError('INVALID_INPUT', '工具不存在');
        const signal = options?.abortSignal ? AbortSignal.any([extra.signal, options.abortSignal]) : extra.signal;
        if (signal.aborted) throw new AppError('TIMEOUT', '工具调用已取消');
        return await entry.invoke(request.params.arguments, { signal });
      } catch (error) {
        const safe = safeError(error);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: safe.code, message: safe.message } }) }], isError: true };
      }
    });
  }

  #add(entry: Entry): void { if (this.#entries.has(entry.definition.name)) throw new AppError('MCP_SCHEMA_INVALID', '工具名称重复'); this.#entries.set(entry.definition.name, entry); }
}

function asSchema(shape: Shape): z.ZodType { return shape instanceof z.ZodType ? shape : z.object(shape); }
