import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { AppError } from '../shared/errors.js';
import { MAX_UPSTREAM_MESSAGE_BYTES } from './stdio-client-transport.js';

/** Bound JSON responses and individual SSE events, not the lifetime of the SSE stream. */
export function upstreamFetch(endpoint: URL, lifetime: AbortSignal): FetchLike {
  return async (input, init) => {
    if (new URL(input).href !== endpoint.href) throw new AppError('MCP_UPSTREAM_FAILED', '上游请求地址发生变化');
    const controller = new AbortController();
    const signals = [lifetime, controller.signal, ...(init?.signal ? [init.signal] : [])];
    const signal = AbortSignal.any(signals);
    const timer = setTimeout(() => controller.abort(), 30_000);
    const dispose = (): void => { clearTimeout(timer); signal.removeEventListener('abort', dispose); };
    signal.addEventListener('abort', dispose, { once: true });
    if (signal.aborted) dispose();
    let response: Response;
    try { response = await fetch(input, { ...init, redirect: 'error', signal }); }
    catch { dispose(); throw new AppError('MCP_UPSTREAM_UNAVAILABLE', '无法连接上游 HTTP MCP'); }
    const sse = response.headers.get('content-type')?.split(';')[0]?.trim() === 'text/event-stream';
    // Persistent GET streams are idle between calls; transport shutdown still aborts them.
    if (sse && init?.method === 'GET') dispose();
    if (!response.body) { dispose(); return response; }
    if (!sse && Number(response.headers.get('content-length')) > MAX_UPSTREAM_MESSAGE_BYTES) {
      dispose(); await response.body.cancel(); throw new AppError('OUTPUT_LIMIT_EXCEEDED', '上游 HTTP 响应超过大小限制');
    }
    const reader = response.body.getReader();
    let bytes = 0; let lineBytes = 0; let previousCR = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        try {
          const next = await reader.read();
          if (next.done) { dispose(); stream.close(); return; }
          if (sse) {
            for (const byte of next.value) {
              if (++bytes > MAX_UPSTREAM_MESSAGE_BYTES) throw new AppError('OUTPUT_LIMIT_EXCEEDED', '上游 SSE 事件超过大小限制');
              if (byte === 10 && previousCR) { previousCR = false; continue; }
              if (byte === 10 || byte === 13) { if (lineBytes === 0) bytes = 0; lineBytes = 0; }
              else lineBytes++;
              previousCR = byte === 13;
            }
          } else if ((bytes += next.value.byteLength) > MAX_UPSTREAM_MESSAGE_BYTES) throw new AppError('OUTPUT_LIMIT_EXCEEDED', '上游 HTTP 响应超过大小限制');
          stream.enqueue(next.value);
        } catch (error) { dispose(); await reader.cancel().catch(() => undefined); stream.error(error); }
      },
      async cancel() { dispose(); await reader.cancel(); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
