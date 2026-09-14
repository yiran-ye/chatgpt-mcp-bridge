import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookup } from 'node:dns/promises';
import type { LookupAddress, LookupAllOptions } from 'node:dns';
import { EventEmitter } from 'node:events';
import { request, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage, IncomingHttpHeaders } from 'node:http';
import { Readable } from 'node:stream';
import { ATTACHMENT_CONNECTION_TIMEOUT_MS, attachmentUrl, downloadAttachment, isPublicAddress } from '../../src/attachment/download.js';
import { MAX_ATTACHMENT_BYTES } from '../../src/attachment/schemas.js';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: vi.fn() }));
const lookupMock = vi.mocked(lookup as (hostname: string, options: LookupAllOptions) => Promise<LookupAddress[]>);

function response(status: number, headers: IncomingHttpHeaders = {}): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from([0, 255, 13, 10])]), { statusCode: status, headers }) as IncomingMessage;
}

describe('附件 HTTPS 下载边界', () => {
  const requested: Array<{ url: URL; options: RequestOptions }> = [];
  const replies: IncomingMessage[] = [];
  const created: IncomingMessage[] = [];
  const attempts: Array<string> = [];
  beforeEach(() => {
    requested.length = 0; replies.length = 0; created.length = 0; attempts.length = 0;
    lookupMock.mockReset().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    vi.mocked(request).mockReset().mockImplementation(((url: URL, options: RequestOptions, callback: (result: IncomingMessage) => void): ClientRequest => {
      requested.push({ url, options });
      const reply = replies.shift() ?? response(200); created.push(reply);
      const req = new EventEmitter();
      const attempt = attempts.shift();
      return Object.assign(req, { end() {
        queueMicrotask(() => {
          const abort = (): void => { const error = new Error('aborted'); req.emit('error', error); reply.destroy(attempt ? undefined : error); };
          options.signal?.addEventListener('abort', abort, { once: true });
          reply.once('close', () => options.signal?.removeEventListener('abort', abort));
          if (attempt === 'hang') return;
          if (attempt) { req.emit('error', Object.assign(new Error('connection failed'), { code: attempt })); reply.destroy(); return; }
          callback(reply);
          if (options.signal?.aborted) abort();
        });
      }, destroy(error: Error) { req.emit('error', error); reply.destroy(); return req; } }) as ClientRequest;
    }) as typeof request);
  });
  afterEach(() => { vi.useRealTimers(); for (const reply of created) reply.destroy(); });

  it.each([
    '0.0.0.0', '10.1.2.3', '100.100.100.200', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1',
    '192.0.0.1', '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '64:ff9b::7f00:1', 'fe80::1', 'fc00::1', 'ff02::1',
    '2001::1', '2001:db8::1', '2002:7f00:1::', '3fff::1', 'fe80::1%lo0', 'not-an-address',
  ])('拒绝非公网地址 %s', address => expect(isPublicAddress(address)).toBe(false));

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])('允许公网地址 %s', address => expect(isPublicAddress(address)).toBe(true));

  it.each([
    'http://example.org/a', 'file:///etc/passwd', 'sandbox:/mnt/data/a.png', 'data:image/png;base64,eA==',
    'https://user:pass@example.org/a', 'https://example.org:8443/a', 'https://example.org/a#fragment',
    'https://127.1/a', 'https://2130706433/a', 'https://0x7f000001/a', 'https://[::ffff:127.0.0.1]/a',
  ])('在发请求前拒绝不支持的 URL %s', async value => {
    await expect(downloadAttachment(value, new AbortController().signal)).rejects.toMatchObject({ code: 'DOWNLOAD_BLOCKED' });
    expect(request).not.toHaveBeenCalled();
  });

  it('HTTPS 443 可用，DNS 只解析一次且连接固定已校验地址', async () => {
    const result = await downloadAttachment('https://files.example.org:443/a?sig=private', new AbortController().signal);
    expect(result.statusCode).toBe(200); expect(lookup).toHaveBeenCalledTimes(1);
    const entry = requested[0]; expect(entry?.url.hostname).toBe('files.example.org');
    expect(entry?.options).toMatchObject({ method: 'GET', agent: false, family: 4, rejectUnauthorized: true, maxHeaderSize: 16 * 1024, headers: { 'Accept-Encoding': 'identity' } });
    // Changing DNS after validation must not change the address used by the socket.
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const one = vi.fn(); entry?.options.lookup?.('files.example.org', { family: 4 }, one);
    expect(one).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    const all = vi.fn(); entry?.options.lookup?.('files.example.org', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it.each(['ENETUNREACH', 'ECONNREFUSED', 'ECONNRESET'])('首个地址 %s 后仅回退到同次 DNS 校验的地址', async code => {
    lookupMock.mockResolvedValueOnce([{ address: '2606:4700:4700::1111', family: 6 }, { address: '8.8.8.8', family: 4 }]);
    attempts.push(code);
    await downloadAttachment('https://files.example.org/a', new AbortController().signal);
    expect(requested.map(entry => entry.options.family)).toEqual([6, 4]);
    expect(lookup).toHaveBeenCalledTimes(1);
    const callback = vi.fn(); requested[1]?.options.lookup?.('files.example.org', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);
    for (const entry of requested) {
      expect(entry.url.hostname).toBe('files.example.org');
      expect(entry.options.rejectUnauthorized).toBe(true);
    }
  });

  it('悬挂连接在单次预算耗尽后销毁并回退', async () => {
    vi.useFakeTimers();
    lookupMock.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }, { address: '1.1.1.1', family: 4 }]);
    attempts.push('hang');
    const pending = downloadAttachment('https://files.example.org/a', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(ATTACHMENT_CONNECTION_TIMEOUT_MS);
    await expect(pending).resolves.toMatchObject({ statusCode: 200 });
    expect(requested).toHaveLength(2); expect(created[0]?.destroyed).toBe(true);
  });

  it.each(['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT'])('证书错误 %s 不回退', async code => {
    lookupMock.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }, { address: '1.1.1.1', family: 4 }]);
    attempts.push(code);
    await expect(downloadAttachment('https://files.example.org/a', new AbortController().signal)).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
    expect(requested).toHaveLength(1);
  });

  it('取消悬挂连接后不尝试下一个地址', async () => {
    vi.useFakeTimers();
    lookupMock.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }, { address: '1.1.1.1', family: 4 }]);
    attempts.push('hang');
    const controller = new AbortController();
    const pending = downloadAttachment('https://files.example.org/a', controller.signal);
    const checked = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(0); controller.abort(); await checked;
    await vi.advanceTimersByTimeAsync(ATTACHMENT_CONNECTION_TIMEOUT_MS);
    expect(requested).toHaveLength(1); expect(created[0]?.destroyed).toBe(true);
  });

  it('公网 IP 字面量不进行 DNS 查询', async () => {
    await downloadAttachment('https://[2606:4700:4700::1111]/a', new AbortController().signal);
    expect(lookup).not.toHaveBeenCalled(); expect(requested[0]?.options.family).toBe(6);
  });

  it('混合公网与私网 DNS 结果、空结果一律拒绝', async () => {
    for (const addresses of [[], [{ address: '8.8.8.8', family: 4 }, { address: '::1', family: 6 }]]) {
      lookupMock.mockResolvedValueOnce(addresses);
      await expect(downloadAttachment('https://files.example.org/a', new AbortController().signal)).rejects.toMatchObject({ code: 'DOWNLOAD_BLOCKED' });
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('重定向每跳重新检查 DNS，拒绝转向内网且销毁前一响应', async () => {
    const redirect = response(302, { location: 'https://internal.example.org/a' }); replies.push(redirect);
    lookupMock.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]).mockResolvedValueOnce([{ address: '10.1.2.3', family: 4 }]);
    await expect(downloadAttachment('https://files.example.org/a', new AbortController().signal)).rejects.toMatchObject({ code: 'DOWNLOAD_BLOCKED' });
    expect(requested).toHaveLength(1); expect(redirect.destroyed).toBe(true);
  });

  it.each(['http://example.org/a', 'https://user:pass@example.org/a', 'https://[::1]/a', 'https://example.org:9000/a'])('拒绝不安全重定向 %s', async location => {
    replies.push(response(307, { location }));
    await expect(downloadAttachment('https://files.example.org/a', new AbortController().signal)).rejects.toMatchObject({ code: 'DOWNLOAD_BLOCKED' });
    expect(requested).toHaveLength(1);
  });

  it('允许三次相对/跨域重定向，不转发前一跳的查询签名', async () => {
    replies.push(response(301, { location: '/b' }), response(302, { location: 'https://cdn.example.org/c' }), response(308, { location: '/d' }), response(200));
    await downloadAttachment('https://files.example.org/a?token=secret', new AbortController().signal);
    expect(requested.map(entry => entry.url.href)).toEqual(['https://files.example.org/a?token=secret', 'https://files.example.org/b', 'https://cdn.example.org/c', 'https://cdn.example.org/d']);
    expect(lookup).toHaveBeenCalledTimes(4);
    for (const entry of requested) expect(entry.options.headers).toEqual({ 'Accept-Encoding': 'identity' });
  });

  it('超过三次重定向或缺少 Location 时失败', async () => {
    replies.push(...Array.from({ length: 4 }, () => response(302, { location: '/again' })));
    await expect(downloadAttachment('https://files.example.org/a', new AbortController().signal)).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
    expect(requested).toHaveLength(4);
    replies.push(response(302));
    await expect(downloadAttachment('https://files.example.org/a', new AbortController().signal)).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
  });

  it.each([403, 404, 500, 204, 206])('不将 HTTP %i 当作附件保存', async status => {
    lookupMock.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }, { address: '1.1.1.1', family: 4 }]);
    replies.push(response(status));
    const pending = downloadAttachment('https://files.example.org/a?token=secret', new AbortController().signal);
    await expect(pending).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
    await expect(pending).rejects.not.toThrow('secret');
    expect(created[0]?.destroyed).toBe(true); expect(requested).toHaveLength(1);
  });

  it.each([
    [{ 'content-length': String(MAX_ATTACHMENT_BYTES + 1) }, 'FILE_TOO_LARGE'],
    [{ 'content-length': '-1' }, 'DOWNLOAD_FAILED'], [{ 'content-length': 'NaN' }, 'DOWNLOAD_FAILED'],
    [{ 'content-length': '9007199254740992' }, 'DOWNLOAD_FAILED'], [{ 'content-encoding': 'gzip' }, 'DOWNLOAD_FAILED'],
  ])('拒绝无效响应头 %j', async (headers, code) => {
    replies.push(response(200, headers));
    await expect(downloadAttachment('https://files.example.org/a', new AbortController().signal)).rejects.toMatchObject({ code });
    expect(created[0]?.destroyed).toBe(true);
  });

  it('允许缺失长度或恰好上限的声明；实际字节由保存层计数', async () => {
    replies.push(response(200), response(200, { 'content-length': String(MAX_ATTACHMENT_BYTES), 'content-encoding': 'identity' }));
    await downloadAttachment('https://files.example.org/a', new AbortController().signal);
    await downloadAttachment('https://files.example.org/a', new AbortController().signal);
    expect(requested).toHaveLength(2);
  });

  it('DNS 失败隐藏地址，取消悬挂 DNS 时不会建立连接', async () => {
    lookupMock.mockRejectedValueOnce(new Error('secret-host-and-token'));
    const failed = downloadAttachment('https://files.example.org/a', new AbortController().signal);
    await expect(failed).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
    await expect(failed).rejects.not.toThrow('secret');
    const controller = new AbortController(); let finish!: () => void;
    lookupMock.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve; }); return [{ address: '8.8.8.8', family: 4 }]; });
    const pending = downloadAttachment('https://files.example.org/a', controller.signal); controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' }); finish(); await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
  });

  it('响应头返回后取消，也销毁尚未被消费的正文', async () => {
    const controller = new AbortController(); const result = await downloadAttachment('https://files.example.org/a', controller.signal);
    controller.abort(); await new Promise(resolve => setImmediate(resolve)); expect(result.destroyed).toBe(true);
  });

  it('链接校验不会暴露原始 URL', () => expect(() => attachmentUrl('https://user:secret@example.org/a')).toThrow(expect.not.stringContaining('secret')));
});
