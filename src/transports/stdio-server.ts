import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from '../server/create-server.js';
import type { WorkspaceContext } from '../workspace/workspace-context.js';
import type { AuditLogger } from '../security/audit-logger.js';
import type { BridgeOptions } from '../runtime/access.js';

export async function startStdio(workspace: WorkspaceContext, logger?: AuditLogger, options?: BridgeOptions): Promise<void> {
  const server = createMcpServer(workspace, logger, options); await server.connect(new StdioServerTransport());
  process.stderr.write(`[chatgpt-mcp-bridge] stdio ready (${workspace.name})\n`);
}
