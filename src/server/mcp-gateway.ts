import { z } from 'zod/v4';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { WorkspaceContext } from '../workspace/workspace-context.js';
import { MAX_MCP_RESULT_BYTES, type McpProxyRuntime } from '../mcp/proxy-runtime.js';
import type { AuditLogger } from '../security/audit-logger.js';
import { requestDigest } from '../security/output-limiter.js';
import { COMMAND_ANNOTATIONS, READ_ONLY_ANNOTATIONS } from '../shared/constants.js';
import { AppError, safeError } from '../shared/errors.js';
import type { BuiltinToolRegistrar } from './tool-catalog.js';

const serverId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/u);
const listInput = z.object({ serverId, cursor: z.string().max(4096).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u).optional() }).strict();
const callInput = z.object({ serverId, toolName: z.string().min(1).max(256), arguments: z.record(z.string(), z.unknown()).default({}) }).strict();

/** Only these static definitions reach the client; upstream schemas are query results. */
export function registerMcpGateway(catalog: BuiltinToolRegistrar, workspace: WorkspaceContext, proxy?: McpProxyRuntime, logger?: AuditLogger): void {
  if (proxy && proxy.workspaceRoot !== workspace.root) throw new AppError('MCP_CONFIG_INVALID', 'MCP 代理运行时属于另一个工作区');
  const requireProxy = (): McpProxyRuntime => {
    if (!proxy) throw new AppError('MCP_UPSTREAM_UNAVAILABLE', '未配置上游 MCP 服务；配置项目 mcp.json 后重启 Bridge');
    return proxy;
  };
  catalog.registerTool('mcp_list_servers', {
    description: '查询项目配置的 MCP 服务、连接状态及工具数量。先查询服务，再用 mcp_list_tools 获取工具和参数说明。配置变更后需重启 Bridge。',
    inputSchema: z.object({}).strict(), annotations: READ_ONLY_ANNOTATIONS,
  }, () => Promise.resolve(jsonResult({ enabled: Boolean(proxy), servers: proxy?.summaries() ?? [] })));
  catalog.registerTool('mcp_list_tools', {
    description: '查询指定 MCP 服务的工具目录，返回原始工具名称、说明、inputSchema、outputSchema 和注解。用 nextCursor 获取后续页，再通过 mcp_call_tool 调用。',
    inputSchema: listInput, annotations: READ_ONLY_ANNOTATIONS,
  }, (input: z.infer<typeof listInput>) => {
    const tools = requireProxy().listTools(input.serverId);
    const digest = requestDigest({ serverId: input.serverId, tools });
    const offset = input.cursor ? workspace.cursors.verify(input.cursor, 'mcp_list_tools', digest) : 0;
    if (offset > tools.length) throw new AppError('INVALID_CURSOR', '游标与当前目录不匹配');
    const selected: typeof tools = [];
    let result = jsonResult({ serverId: input.serverId, tools: selected });
    for (let index = offset; index < tools.length && selected.length < 100; index++) {
      const tool = tools[index]; if (!tool) break;
      const candidate = jsonResult({ serverId: input.serverId, tools: [...selected, tool], ...(index + 1 < tools.length ? { nextCursor: workspace.cursors.sign('mcp_list_tools', index + 1, digest) } : {}) });
      if (Buffer.byteLength(JSON.stringify(candidate)) > MAX_MCP_RESULT_BYTES) break;
      selected.push(tool); result = candidate;
    }
    if (!selected.length && offset < tools.length) throw new AppError('OUTPUT_LIMIT_EXCEEDED', '单个上游工具定义超过返回大小限制');
    return Promise.resolve(result);
  });
  catalog.registerTool('mcp_call_tool', {
    description: '调用已配置 MCP 服务的工具。先用 mcp_list_tools 查询最新参数结构，将服务 ID、原始工具名称和符合 inputSchema 的 JSON 对象传入。上游工具可能写入文件、执行命令或访问网络。',
    inputSchema: callInput, annotations: COMMAND_ANNOTATIONS,
  }, async (input: z.infer<typeof callInput>, extra) => {
    const started = Date.now(); const target = `${input.serverId}/${input.toolName}`;
    try {
      const result = await requireProxy().callTool(input.serverId, input.toolName, input.arguments, extra.signal);
      await logger?.event('mcp_call_tool', result.isError ? 'deny' : 'allow', Date.now() - started, Buffer.byteLength(JSON.stringify(result)), result.isError ? 'MCP_UPSTREAM_FAILED' : undefined, target);
      return result;
    } catch (error) {
      await logger?.event('mcp_call_tool', 'deny', Date.now() - started, 0, safeError(error).code, target);
      throw error;
    }
  });
}

function jsonResult(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}
