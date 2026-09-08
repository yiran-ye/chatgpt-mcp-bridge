import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod/v4';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpServer } from '../server/create-server.js';
import type { WorkspaceContext } from '../workspace/workspace-context.js';
import type { AuditLogger } from '../security/audit-logger.js';
import { bearerAuthorized } from './auth-policy.js';
import { originAllowed } from './origin-policy.js';
import { RateLimiter } from '../security/rate-limiter.js';
import { AppError } from '../shared/errors.js';
import type { BridgeOptions } from '../runtime/access.js';
import { effectiveAccess } from '../runtime/access.js';
import { MutationCoordinator } from '../security/mutation-coordinator.js';

export interface HttpOptions { host: string; port: number; mcpPath: string; allowPublicBind: boolean; authToken?: string; requestTimeoutMs?: number; maxConcurrent?: number; maxSseConnections?: number }
export interface RunningHttpServer { server: Server; url: string; close(): Promise<void> }
type JsonRpcId = string | number;

const sseLimitSchema = z.number().int().positive().default(16);
const jsonRpcIdSchema = z.union([z.string(), z.number()]);
const requestMessageSchema = z.object({ jsonrpc: z.literal('2.0'), id: jsonRpcIdSchema, method: z.string() });
const cancellationMessageSchema = z.object({ jsonrpc: z.literal('2.0'), method: z.literal('notifications/cancelled'), params: z.object({ requestId: jsonRpcIdSchema }) });

export async function startHttpServer(workspace: WorkspaceContext, options: HttpOptions, logger?: AuditLogger, bridgeOptions?: BridgeOptions): Promise<RunningHttpServer> {
  const publicBind = !['127.0.0.1', 'localhost', '::1'].includes(options.host);
  let maxSseConnections: number;
  try {
    const parsedLimit = sseLimitSchema.safeParse(options.maxSseConnections);
    if (!parsedLimit.success) throw new AppError('INVALID_INPUT', 'SSE 连接上限必须是正整数');
    maxSseConnections = parsedLimit.data;
    assertHttpSecurity(options, effectiveAccess(bridgeOptions) !== 'read-only' || Boolean(bridgeOptions?.mcpProxy));
    if (bridgeOptions?.mcpProxy && bridgeOptions.mcpProxy.workspaceRoot !== workspace.root) throw new AppError('MCP_CONFIG_INVALID', 'MCP 代理运行时属于另一个工作区');
  } catch (error) { await bridgeOptions?.mcpProxy?.close(); throw error; }
  const rate = new RateLimiter(); let active = 0; let activeSse = 0; const maxConcurrent = options.maxConcurrent ?? 16; const mutationCoordinator = bridgeOptions?.mutationCoordinator ?? new MutationCoordinator(); const inFlight = new Map<string, Set<AbortController>>(); const controllers = new Set<AbortController>();
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Cache-Control', 'no-store');
    const remote = request.socket.remoteAddress ?? 'unknown';
    if (!rate.allow(remote)) return json(response, 429, { error: 'rate limit exceeded' });
    if (request.url === '/health' && request.method === 'GET') return json(response, 200, { status: 'ok' });
    if (request.url !== options.mcpPath) return json(response, 404, { error: 'not found' });
    if (!originAllowed(header(request, 'origin'), options.host, publicBind)) return json(response, 403, { error: 'origin not allowed' });
    if (!bearerAuthorized(header(request, 'authorization'), options.authToken)) return json(response, 401, { error: 'unauthorized' });
    if (request.method !== 'POST' && request.method !== 'GET' && request.method !== 'DELETE') return json(response, 405, { error: 'method not allowed' });
    let body: unknown; try { body = request.method === 'POST' ? await readBody(request, 1024 * 1024) : undefined; } catch { return json(response, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }); }
    if (abortCancelledRequests(body, inFlight)) { response.writeHead(202); response.end(); return; }
    // GET reserves an independent slot, including its handshake, so persistent
    // streams cannot consume the capacity used by tool calls and initialization.
    const sseRequest = request.method === 'GET';
    if (sseRequest) {
      if (activeSse >= maxSseConnections) return json(response, 503, { error: 'SSE connection limit exceeded' });
      activeSse++;
    } else {
      if (active >= maxConcurrent) return json(response, 503, { error: 'server busy' });
      active++;
    }
    const controller = new AbortController(); const abortRequest = (): void => { if (!controller.signal.aborted) controller.abort(); }; const onResponseClose = (): void => { if (!response.writableEnded) abortRequest(); };
    const onAbort = (): void => { if (!response.writableEnded && !response.destroyed) response.destroy(); };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    controllers.add(controller);
    request.once('aborted', abortRequest); response.once('close', onResponseClose);
    const timer = setTimeout(() => { if (!response.headersSent) json(response, 408, { error: 'request timeout' }); else if (!response.writableEnded) response.destroy(); abortRequest(); if (!request.complete) request.destroy(); }, options.requestTimeoutMs ?? 30_000);
    // The SDK produces a Web Response; this layer alone owns the Node response.
    // A late tool result after a deadline is discarded without a second HTTP write.
    const mcp = createMcpServer(workspace, logger, { ...bridgeOptions, mutationCoordinator, abortSignal: controller.signal });
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    let unregister = (): void => undefined;
    try {
      unregister = registerInFlightRequests(body, controller, inFlight);
      await mcp.connect(transport as unknown as Parameters<typeof mcp.connect>[0]);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, value);
      }
      const webRequest = new Request(new URL(options.mcpPath, 'http://localhost'), { method: request.method ?? 'POST', headers, signal: controller.signal });
      const result = await transport.handleRequest(webRequest, { parsedBody: body });
      // Bound the handshake, not the lifetime of an established event stream.
      if (sseRequest && result.status === 200 && result.body && isEventStream(result)) clearTimeout(timer);
      await writeResponse(result, response, controller.signal);
    } catch {
      json(response, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    } finally {
      unregister(); controllers.delete(controller); clearTimeout(timer);
      request.off('aborted', abortRequest); response.off('close', onResponseClose); controller.signal.removeEventListener('abort', onAbort);
      if (sseRequest) activeSse--; else active--;
      await transport.close().catch(() => undefined); await mcp.close().catch(() => undefined);
    }
  });
  server.requestTimeout = options.requestTimeoutMs ?? 30_000; server.headersTimeout = 10_000;
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, options.host, () => { server.off('error', reject); resolve(); }); }); }
  catch (error) { await bridgeOptions?.mcpProxy?.close(); throw error; }
  const address = server.address() as AddressInfo; const displayHost = options.host === '::1' ? '[::1]' : options.host;
  let closing: Promise<void> | undefined;
  return { server, url: `http://${displayHost}:${address.port}${options.mcpPath}`, close: () => {
    closing ??= Promise.resolve().then(async () => {
      for (const controller of controllers) controller.abort();
      await Promise.all([bridgeOptions?.mcpProxy?.close(), new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))]);
    });
    return closing;
  } };
}

/** Also called by the CLI before it starts any configured upstream process. */
export function assertHttpSecurity(options: HttpOptions, privileged: boolean): void {
  const publicBind = !['127.0.0.1', 'localhost', '::1'].includes(options.host);
  if (privileged && publicBind) throw new AppError('UNAUTHORIZED', '写入、命令或 MCP 代理模式禁止 public bind');
  if (privileged && (!options.authToken || options.authToken.length < 32)) throw new AppError('UNAUTHORIZED', 'HTTP 写入、命令或 MCP 代理模式需要至少 32 字符的认证 Token');
  if (publicBind && (!options.allowPublicBind || !options.authToken)) throw new AppError('UNAUTHORIZED', 'public bind 必须同时提供 --allow-public-bind 和认证 Token');
}

function header(request: IncomingMessage, name: string): string | undefined { const value = request.headers[name]; return Array.isArray(value) ? value[0] : value; }
function json(response: ServerResponse, status: number, body: unknown): void { if (response.headersSent || response.writableEnded || response.destroyed) return; response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body)); }
function isEventStream(result: Response): boolean { return result.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'text/event-stream'; }
async function writeResponse(result: Response, response: ServerResponse, signal: AbortSignal): Promise<void> {
  if (signal.aborted || response.writableEnded || response.destroyed) {
    await result.body?.cancel();
    return;
  }
  response.writeHead(result.status, Object.fromEntries(result.headers));
  if (isEventStream(result)) response.flushHeaders();
  if (!result.body) { response.end(); return; }
  await pipeline(Readable.fromWeb(result.body as Parameters<typeof Readable.fromWeb>[0]), response, { signal });
}
async function readBody(request: IncomingMessage, limit: number): Promise<unknown> { const chunks: Buffer[] = []; let size = 0; for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length; if (size > limit) throw new AppError('OUTPUT_LIMIT_EXCEEDED', 'HTTP 请求体过大'); chunks.push(buffer); } try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { throw new AppError('INVALID_INPUT', 'JSON 请求体无效'); } }
function requestKey(id: JsonRpcId): string { return `${typeof id}:${String(id)}`; }
function messages(body: unknown): unknown[] { return Array.isArray(body) ? body : [body]; }
function abortCancelledRequests(body: unknown, inFlight: Map<string, Set<AbortController>>): boolean { const bodyMessages = messages(body); let cancellations = 0; for (const message of bodyMessages) { const parsed = cancellationMessageSchema.safeParse(message); if (parsed.success) { cancellations++; for (const controller of inFlight.get(requestKey(parsed.data.params.requestId)) ?? []) controller.abort(); } } return cancellations > 0 && cancellations === bodyMessages.length; }
function registerInFlightRequests(body: unknown, controller: AbortController, inFlight: Map<string, Set<AbortController>>): () => void {
  const keys = messages(body).flatMap(message => { const parsed = requestMessageSchema.safeParse(message); return parsed.success ? [requestKey(parsed.data.id)] : []; });
  for (const key of keys) { const controllers = inFlight.get(key) ?? new Set<AbortController>(); controllers.add(controller); inFlight.set(key, controllers); }
  return () => { for (const key of keys) { const controllers = inFlight.get(key); controllers?.delete(controller); if (controllers?.size === 0) inFlight.delete(key); } };
}
