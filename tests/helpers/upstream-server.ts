import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode, type Tool } from '@modelcontextprotocol/sdk/types.js';

export const echoSchema: Tool['inputSchema'] = {
  type: 'object', $schema: 'https://json-schema.org/draft/2020-12/schema',
  properties: { message: { type: 'string' }, option: { anyOf: [{ type: 'integer' }, { type: 'string' }] }, defaulted: { type: 'string', default: 'untouched' } },
  required: ['message'], additionalProperties: false,
};
export interface UpstreamState { calls: Array<{ name: string; args: unknown }>; cancelled: number; requests: number; mode?: string; token?: string }
export function fixtureServer(state: UpstreamState): McpServer {
  const server = new McpServer({ name: 'upstream-fixture', version: '1' }, { capabilities: { tools: {} } });
  server.server.setRequestHandler(ListToolsRequestSchema, () => {
    const tools: Tool[] = [
      { name: 'echo', description: 'Echo structured arguments', inputSchema: echoSchema, outputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      ...['fail', 'rpc_error', 'bad_output', 'environment', 'read_file'].map(name => ({ name, inputSchema: { type: 'object' as const }, ...(name === 'bad_output' ? { outputSchema: { type: 'object' as const, properties: { answer: { type: 'string' } }, required: ['answer'] } } : {}) })),
      { name: 'delay', inputSchema: { type: 'object', properties: { milliseconds: { type: 'integer', minimum: 1, maximum: 120_000 } }, required: ['milliseconds'] } },
      { name: 'large', inputSchema: { type: 'object', properties: { size: { type: 'integer', minimum: 1, maximum: 2 * 1024 * 1024 } }, required: ['size'] } },
    ];
    if (state.mode === 'names') for (const name of ['same.name', 'same_name', 'x'.repeat(100)]) tools.push({ name, inputSchema: { type: 'object' } });
    if (state.mode === 'many') for (let i = 0; i < 110; i++) tools.push({ name: `tool_${i}`, inputSchema: { type: 'object' } });
    if (state.mode === 'large-catalog') for (let i = 0; i < 4; i++) tools.push({ name: 'large_definition_' + String(i), description: 'x'.repeat(180_000), inputSchema: { type: 'object' } });
    if (state.mode === 'oversized-definition') tools.unshift({ name: 'too_large', description: 'x'.repeat(600_000), inputSchema: { type: 'object' } });
    const first = tools[0]; if (!first) throw new Error('fixture tool missing');
    if (state.mode === 'changed') {
      first.description = 'Changed tool with a new argument and side effects';
      first.inputSchema = { type: 'object', properties: { count: { type: 'number' } }, required: ['count'], additionalProperties: false };
      first.outputSchema = first.inputSchema; first.annotations = { readOnlyHint: false, destructiveHint: true };
    }
    if (state.mode === 'remote-ref') first.inputSchema = { type: 'object', properties: { secret: { $ref: 'https://example.invalid/private' } } };
    if (state.mode === 'bad-schema') first.inputSchema = { type: 'object', properties: { broken: { type: 'not-a-json-schema-type' } } };
    if (state.mode === 'same-id') {
      first.inputSchema = { ...echoSchema, $id: 'https://example.invalid/shared' };
      tools.push({ name: 'different', inputSchema: { type: 'object', $id: 'https://example.invalid/shared', properties: { count: { type: 'number' } }, required: ['count'] } });
    }
    return { tools };
  });
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = request.params.arguments ?? {}; const name = request.params.name;
    state.calls.push({ name, args });
    if (name === 'rpc_error') throw new McpError(ErrorCode.InternalError, 'UPSTREAM-PRIVATE-DETAIL');
    if (name === 'fail') return { content: [{ type: 'text', text: 'expected failure' }], isError: true };
    if (name === 'bad_output') return { content: [{ type: 'text', text: 'invalid' }], structuredContent: { answer: 42 } };
    if (name === 'environment') return { content: [{ type: 'text', text: 'environment' }], structuredContent: { allowed: process.env['MCP_TEST_ALLOWED'] ?? null, privateForwarded: Boolean(process.env['MCP_TEST_PRIVATE']), argument: process.argv.at(-1), cwd: process.cwd() } };
    if (name === 'large') return { content: [{ type: 'text', text: 'x'.repeat(Number(args['size'])) }] };
    if (name === 'delay') await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { extra.signal.removeEventListener('abort', cancel); resolve(); }, Number(args['milliseconds']));
      const cancel = (): void => { clearTimeout(timer); state.cancelled++; reject(new Error('cancelled')); };
      extra.signal.addEventListener('abort', cancel, { once: true }); if (extra.signal.aborted) cancel();
    });
    return {
      content: [{ type: 'text', text: String(args['message'] ?? name) }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }, { type: 'audio', data: 'aGVsbG8=', mimeType: 'audio/wav' }],
      structuredContent: args,
    };
  });
  return server;
}

export async function httpUpstream(options: { mode?: string; token?: string; redirect?: string } = {}): Promise<{ url: string; state: UpstreamState; close(): Promise<void> }> {
  const state: UpstreamState = { calls: [], cancelled: 0, requests: 0, ...options };
  const server = fixtureServer(state);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
  await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
  const http = createServer(async (request, response) => {
    state.requests++;
    if (options.redirect) { response.writeHead(302, { Location: options.redirect }); response.end(); return; }
    if (options.token && request.headers.authorization !== `Bearer ${options.token}`) { response.writeHead(401); response.end(); return; }
    try {
      await transport.handleRequest(request, response);
    } catch { if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`, state, close: async () => {
    await server.close();
    http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
  } };
}
