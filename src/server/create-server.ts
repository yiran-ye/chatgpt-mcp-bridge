import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tool-registry.js';
import type { WorkspaceContext } from '../workspace/workspace-context.js';
import type { AuditLogger } from '../security/audit-logger.js';

export function createMcpServer(workspace: WorkspaceContext, logger?: AuditLogger): McpServer {
  const server = new McpServer({ name: 'chatgpt-mcp-bridge', version: '0.2.0' });
  registerTools(server, workspace, logger); return server;
}
