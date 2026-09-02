import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from '../server/create-server.js';
import type { WorkspaceContext } from '../workspace/workspace-context.js';
import type { AuditLogger } from '../security/audit-logger.js';
import { bearerAuthorized } from './auth-policy.js';
import { originAllowed } from './origin-policy.js';
import { RateLimiter } from '../security/rate-limiter.js';
import { AppError } from '../shared/errors.js';

export interface HttpOptions { host: string; port: number; mcpPath: string; allowPublicBind: boolean; authToken?: string; requestTimeoutMs?: number; maxConcurrent?: number }
export interface RunningHttpServer { server: Server; url: string; close(): Promise<void> }

export async function startHttpServer(workspace: WorkspaceContext, options: HttpOptions, logger?: AuditLogger): Promise<RunningHttpServer> {
  const publicBind = !['127.0.0.1', 'localhost', '::1'].includes(options.host);
  if (publicBind && (!options.allowPublicBind || !options.authToken)) throw new AppError('UNAUTHORIZED', 'public bind 必须同时提供 --allow-public-bind 和认证 Token');
  const rate = new RateLimiter(); let active = 0; const maxConcurrent = options.maxConcurrent ?? 16;
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Cache-Control', 'no-store');
    const remote = request.socket.remoteAddress ?? 'unknown';
    if (!rate.allow(remote)) return json(response, 429, { error: 'rate limit exceeded' });
    if (request.url === '/health' && request.method === 'GET') return json(response, 200, { status: 'ok' });
    if (request.url !== options.mcpPath) return json(response, 404, { error: 'not found' });
    if (!originAllowed(header(request, 'origin'), options.host, publicBind)) return json(response, 403, { error: 'origin not allowed' });
    if (!bearerAuthorized(header(request, 'authorization'), options.authToken)) return json(response, 401, { error: 'unauthorized' });
    if (request.method !== 'POST' && request.method !== 'GET' && request.method !== 'DELETE') return json(response, 405, { error: 'method not allowed' });
    if (active >= maxConcurrent) return json(response, 503, { error: 'server busy' }); active++;
    const timer = setTimeout(() => { if (!response.headersSent) json(response, 408, { error: 'request timeout' }); request.destroy(); }, options.requestTimeoutMs ?? 30_000);
    const mcp = createMcpServer(workspace, logger); const transportOptions = { sessionIdGenerator: undefined } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]; const transport = new StreamableHTTPServerTransport(transportOptions);
    try { const body = request.method === 'POST' ? await readBody(request, 1024 * 1024) : undefined; await mcp.connect(transport as unknown as Parameters<typeof mcp.connect>[0]); await transport.handleRequest(request, response, body); }
    catch { if (!response.headersSent) json(response, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }); }
    finally { clearTimeout(timer); active--; if (request.method === 'POST') { await transport.close().catch(() => undefined); await mcp.close().catch(() => undefined); } }
  });
  server.requestTimeout = options.requestTimeoutMs ?? 30_000; server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, options.host, () => { server.off('error', reject); resolve(); }); });
  const address = server.address() as AddressInfo; const displayHost = options.host === '::1' ? '[::1]' : options.host;
  return { server, url: `http://${displayHost}:${address.port}${options.mcpPath}`, close: async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

function header(request: IncomingMessage, name: string): string | undefined { const value = request.headers[name]; return Array.isArray(value) ? value[0] : value; }
function json(response: ServerResponse, status: number, body: unknown): void { if (response.writableEnded) return; response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body)); }
async function readBody(request: IncomingMessage, limit: number): Promise<unknown> { const chunks: Buffer[] = []; let size = 0; for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length; if (size > limit) throw new AppError('OUTPUT_LIMIT_EXCEEDED', 'HTTP 请求体过大'); chunks.push(buffer); } try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { throw new AppError('INVALID_INPUT', 'JSON 请求体无效'); } }
