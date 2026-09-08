export type AccessMode = 'read-only' | 'workspace-write' | 'command-exec' | 'full-access';

export interface CommandDefinition {
  description: string;
  executable: string;
  fixedArgs: string[];
  allowAdditionalArgs: boolean;
  forwardEnv: string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface CommandConfig {
  version: 1;
  commands: Record<string, CommandDefinition>;
}

export interface BridgeOptions {
  access?: AccessMode;
  commandConfig?: CommandConfig;
  mutationCoordinator?: MutationCoordinator;
  abortSignal?: AbortSignal;
  /** Explicitly initialized upstreams. The service transport owns shutdown, not individual requests. */
  mcpProxy?: McpProxyRuntime;
}

export function effectiveAccess(options?: BridgeOptions): AccessMode {
  return options?.access ?? 'read-only';
}
import type { MutationCoordinator } from '../security/mutation-coordinator.js';
import type { McpProxyRuntime } from '../mcp/proxy-runtime.js';
