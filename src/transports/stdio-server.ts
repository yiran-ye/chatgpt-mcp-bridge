import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from '../server/create-server.js';
import type { WorkspaceContext } from '../workspace/workspace-context.js';
import type { AuditLogger } from '../security/audit-logger.js';
import type { BridgeOptions } from '../runtime/access.js';

export async function startStdio(workspace: WorkspaceContext, logger?: AuditLogger, options?: BridgeOptions): Promise<void> {
  let server: ReturnType<typeof createMcpServer>;
  try { server = createMcpServer(workspace, logger, options); }
  catch (error) { await options?.mcpProxy?.close(); throw error; }
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= Promise.resolve().then(async () => {
      process.off('SIGINT', stop); process.off('SIGTERM', stop); process.stdin.off('end', stop);
      await Promise.all([server.close(), options?.mcpProxy?.close()]);
    });
    return closing;
  };
  const stop = (): void => { void close().catch(() => { process.exitCode = 1; }); };
  server.server.onclose = stop;
  process.once('SIGINT', stop); process.once('SIGTERM', stop); process.stdin.once('end', stop);
  try { await server.connect(new StdioServerTransport()); }
  catch (error) { await close(); throw error; }
  process.stderr.write(`[chatgpt-mcp-bridge] stdio ready (${workspace.name})\n`);
}
