import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from '../server/create-server.js';
import type { WorkspaceContext } from '../workspace/workspace-context.js';
import type { AuditLogger } from '../security/audit-logger.js';

export async function startStdio(workspace: WorkspaceContext, logger?: AuditLogger): Promise<void> {
  const server = createMcpServer(workspace, logger); await server.connect(new StdioServerTransport());
  process.stderr.write(`[local-code-mcp] stdio ready (${workspace.name})\n`);
}
