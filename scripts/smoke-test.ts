import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WorkspaceContext } from '../src/workspace/workspace-context.js';
import { startHttpServer } from '../src/transports/http-server.js';

const root = await mkdtemp(path.join(tmpdir(), 'chatgpt-mcp-bridge-smoke-'));
try {
  execFileSync('git', ['init', '-b', 'main'], { cwd: root }); execFileSync('git', ['config', 'user.name', 'Smoke'], { cwd: root }); execFileSync('git', ['config', 'user.email', 'smoke@localhost.invalid'], { cwd: root });
  await writeFile(path.join(root, 'hello.ts'), 'export const hello = "world";\n'); execFileSync('git', ['add', '.'], { cwd: root }); execFileSync('git', ['commit', '-m', 'initial'], { cwd: root }); await writeFile(path.join(root, 'hello.ts'), 'export const hello = "changed";\n');
  const workspace = await WorkspaceContext.create(root); const running = await startHttpServer(workspace, { host: '127.0.0.1', port: 0, mcpPath: '/mcp', allowPublicBind: false });
  try { const health = await fetch(running.url.replace('/mcp', '/health')); if (!health.ok) throw new Error('health failed'); const client = new Client({ name: 'smoke', version: '1' }); await client.connect(new StreamableHTTPClientTransport(new URL(running.url)) as unknown as Parameters<typeof client.connect>[0]); const tools = await client.listTools(); if (tools.tools.length !== 10) throw new Error('tool count mismatch'); for (const name of ['change_context', 'git_status']) { const result = await client.callTool({ name, arguments: {} }); if (result.isError) throw new Error(`${name} failed`); } for (const [name, args] of [['git_diff', { scope: 'working_tree' }], ['read_file', { path: 'hello.ts' }]] as const) { const result = await client.callTool({ name, arguments: args }); if (result.isError) throw new Error(`${name} failed`); } await client.close(); process.stdout.write(`smoke ok: health, initialize, ${tools.tools.length} tools, 4 calls\n`); } finally { await running.close(); }
} finally { await rm(root, { recursive: true, force: true }); }
