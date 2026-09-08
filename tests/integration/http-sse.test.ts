import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceContext } from '../../src/workspace/workspace-context.js';
import { startHttpServer, type RunningHttpServer } from '../../src/transports/http-server.js';

const roots: string[] = [];
const servers: RunningHttpServer[] = [];
const connections: AbortController[] = [];
afterEach(async () => {
  for (const controller of connections.splice(0)) controller.abort();
  await Promise.all(servers.splice(0).map(server => server.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});
async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-sse-')); roots.push(root);
  return await WorkspaceContext.create(root);
}
async function serve(options: { maxConcurrent?: number; maxSseConnections?: number; requestTimeoutMs?: number } = {}) {
  const running = await startHttpServer(await workspace(), { host: '127.0.0.1', port: 0, mcpPath: '/mcp', allowPublicBind: false, ...options });
  servers.push(running); return running;
}
async function openSse(running: RunningHttpServer, accept = 'text/event-stream') {
  const controller = new AbortController(); connections.push(controller);
  const response = await fetch(running.url, { headers: { Accept: accept }, signal: controller.signal });
  return { response, controller };
}
async function initialize(running: RunningHttpServer) {
  return await fetch(running.url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'sse-test', version: '1' } } }),
  });
}

describe('HTTP SSE 配额与持久连接', () => {
  it('SSE 满额不会占用 POST 槽位，断连后可重新建立 SSE', async () => {
    const errors = vi.spyOn(console, 'error');
    const running = await serve({ maxConcurrent: 2, maxSseConnections: 2 });
    const first = await openSse(running); const second = await openSse(running);
    expect(first.response.status).toBe(200); expect(second.response.status).toBe(200);
    const rejected = await openSse(running);
    expect(rejected.response.status).toBe(503);
    expect(await rejected.response.json()).toEqual({ error: 'SSE connection limit exceeded' });
    const post = await initialize(running);
    expect(post.status).toBe(200); expect(await post.json()).toMatchObject({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } });
    first.controller.abort();
    await vi.waitFor(async () => {
      const replacement = await openSse(running);
      if (replacement.response.status !== 200) await replacement.response.text();
      expect(replacement.response.status).toBe(200);
    });
    await running.close(); expect(errors).not.toHaveBeenCalled();
  });
  it('建立后的 SSE 超过普通 deadline 仍存活，服务关闭才结束流', async () => {
    const errors = vi.spyOn(console, 'error');
    const running = await serve({ requestTimeoutMs: 100 });
    const { response } = await openSse(running); expect(response.status).toBe(200);
    let ended = false;
    const completion = response.text().then(() => { ended = true; }, () => { ended = true; });
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(ended).toBe(false);
    const post = await initialize(running); expect(post.status).toBe(200); await post.json();
    await running.close(); await completion; expect(ended).toBe(true); expect(errors).not.toHaveBeenCalled();
  });
  it('被拒绝的 GET 握手会释放 SSE 配额', async () => {
    const running = await serve({ maxSseConnections: 1 });
    const invalid = await openSse(running, 'application/json');
    expect(invalid.response.status).toBe(406); await invalid.response.text();
    await vi.waitFor(async () => {
      const valid = await openSse(running);
      if (valid.response.status !== 200) await valid.response.text();
      expect(valid.response.status).toBe(200);
    });
  });
  it.each([0, -1, 1.5, Infinity, NaN])('拒绝非法 SSE 连接上限 %s', async maxSseConnections => {
    await expect(serve({ maxSseConnections })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
