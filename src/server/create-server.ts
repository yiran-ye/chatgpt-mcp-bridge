import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tool-registry.js';
import type { WorkspaceContext } from '../workspace/workspace-context.js';
import type { AuditLogger } from '../security/audit-logger.js';
import type { BridgeOptions } from '../runtime/access.js';
import { effectiveAccess } from '../runtime/access.js';
import { PACKAGE_VERSION } from '../shared/version.js';
import { AppError } from '../shared/errors.js';
import { parseCommandConfig } from '../runtime/command-config.js';

export function createMcpServer(workspace: WorkspaceContext, logger?: AuditLogger, options?: BridgeOptions): McpServer {
  if (effectiveAccess(options) === 'full-access' && options?.commandConfig) throw new AppError('COMMAND_CONFIG_INVALID', 'full-access 不使用命令配置');
  const server = new McpServer({ name: 'chatgpt-mcp-bridge', version: PACKAGE_VERSION });
  const checkedOptions = options?.commandConfig ? { ...options, commandConfig: parseCommandConfig(options.commandConfig) } : options;
  registerTools(server, workspace, logger, checkedOptions); return server;
}
