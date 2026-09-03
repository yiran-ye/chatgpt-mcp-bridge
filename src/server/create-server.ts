import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tool-registry.js';
import type { WorkspaceContext } from '../workspace/workspace-context.js';
import type { AuditLogger } from '../security/audit-logger.js';
import type { BridgeOptions } from '../runtime/access.js';
import { PACKAGE_VERSION } from '../shared/version.js';
import { parseCommandConfig } from '../runtime/command-config.js';

export function createMcpServer(workspace: WorkspaceContext, logger?: AuditLogger, options?: BridgeOptions): McpServer {
  const server = new McpServer({ name: 'chatgpt-mcp-bridge', version: PACKAGE_VERSION });
  const checkedOptions = options?.commandConfig ? { ...options, commandConfig: parseCommandConfig(options.commandConfig) } : options;
  registerTools(server, workspace, logger, checkedOptions); return server;
}
