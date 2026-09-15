import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { AppError } from '../shared/errors.js';
import { abortable } from '../shared/abort.js';
import { attachmentDownloadUrlSchema, dohResponseSchema, MAX_ATTACHMENT_BYTES } from './schemas.js';

const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blockedV4.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new BlockList();
// Conservative global-unicast policy: exclude special-purpose, documentation and transition ranges.
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) blockedV6.addSubnet(address, prefix, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, 'ipv4');
  // This also excludes IPv4-mapped IPv6, NAT64, loopback, link-local and unique-local addresses.
  return family === 6 && !address.includes('%') && globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
}

const proxyFakeIpV4 = new BlockList(); proxyFakeIpV4.addSubnet('198.18.0.0', 15, 'ipv4');
/** The reserved range proxy cores (Clash/mihomo, Surge, ...) hand out in Fake-IP DNS mode. */
export function isProxyFakeIp(address: string): boolean { return isIP(address) === 4 && proxyFakeIpV4.check(address, 'ipv4'); }

export function attachmentUrl(value: string): URL {
  if (!attachmentDownloadUrlSchema.safeParse(value).success) throw new AppError('DOWNLOAD_BLOCKED', '附件下载地址无效或过长');
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError('DOWNLOAD_BLOCKED', '附件需要有效的公网 HTTPS 下载地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash) throw new AppError('DOWNLOAD_BLOCKED', '附件下载仅允许无凭据的公网 HTTPS 地址和标准端口');
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  if (isIP(hostname) && !isPublicAddress(hostname)) throw new AppError('DOWNLOAD_BLOCKED', '禁止从本机、内网或保留地址下载附件');
  return url;
}

async function openResponse(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  signal.throwIfAborted();
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  const addresses = await resolveAttachmentAddresses(hostname, signal);
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) {
    // Echo only the client-supplied hostname: returning resolved addresses would let a probing client map the intranet.
    throw new AppError('DOWNLOAD_BLOCKED', `附件域名解析到本机、内网或保留地址（${hostname}）`);
  }
  for (const pinned of addresses) {
    signal.throwIfAborted();
    try { return await openPinnedResponse(url, pinned, signal); }
    catch (error) {
      if (signal.aborted || !retryableConnectionCodes.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  throw new AppError('DOWNLOAD_FAILED', '附件下载地址均无法连接');
}

async function resolveAttachmentAddresses(hostname: string, signal: AbortSignal): Promise<LookupAddress[]> {
  const family = isIP(hostname);
  if (family) return [{ address: hostname, family }];
  const system = await abortable(lookup(hostname, { all: true, verbatim: true }), signal);
  // Only the proxy Fake-IP range retries through public DoH. Hosts files, split-DNS and security-software
  // sinkholes also answer with non-public addresses, and those local answers are honored as-is — never
  // sent to third-party resolvers, never bypassed. The DoH answer still passes the same validation.
  if (system.length && system.every(item => isProxyFakeIp(item.address))) {
    const viaDoh = await lookupViaPublicDoh(hostname, signal);
    if (viaDoh.length) return viaDoh;
  }
  return system;
}

interface DohEndpoint { address: string; path: (name: string, type: 'A' | 'AAAA') => string }
// Reached at literal public addresses, so the fallback itself never depends on the system resolver.
const dohEndpoints: DohEndpoint[] = [
  { address: '1.1.1.1', path: (name, type) => `/dns-query?name=${encodeURIComponent(name)}&type=${type}` },
  { address: '8.8.8.8', path: (name, type) => `/resolve?name=${encodeURIComponent(name)}&type=${type}` },
];

async function lookupViaPublicDoh(hostname: string, signal: AbortSignal): Promise<LookupAddress[]> {
  for (const endpoint of dohEndpoints) {
    signal.throwIfAborted();
    if (!isPublicAddress(endpoint.address)) continue;
    try {
      const [v4, v6] = await Promise.all([dohQuery(endpoint, hostname, 'A', signal), dohQuery(endpoint, hostname, 'AAAA', signal)]);
      const addresses: LookupAddress[] = [];
      for (const [body, family] of [[v4, 4], [v6, 6]] as const) {
        const parsed = dohResponseSchema.safeParse(JSON.parse(body.toString('utf8')));
        if (!parsed.success) throw new Error('DoH response failed schema validation');
        for (const record of parsed.data.Answer ?? []) {
          if (isIP(record.data) === family) addresses.push({ address: record.data, family });
        }
      }
      if (addresses.length) return addresses;
    } catch { /* Try the next public resolver; a failed fallback keeps the system result. */ }
  }
  return [];
}

export const DOH_QUERY_TIMEOUT_MS = 3_000;
const DOH_MAX_RESPONSE_BYTES = 16 * 1024;

async function dohQuery(endpoint: DohEndpoint, hostname: string, type: 'A' | 'AAAA', signal: AbortSignal): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, body?: Buffer): void => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error);
      else resolve(body ?? Buffer.alloc(0));
    };
    const req = request(new URL(`https://${endpoint.address}${endpoint.path(hostname, type)}`), {
      method: 'GET', agent: false, signal, rejectUnauthorized: true, maxHeaderSize: 16 * 1024,
      headers: { accept: 'application/dns-json' },
    }, response => {
      response.on('error', () => undefined);
      if (response.statusCode !== 200) { response.destroy(); finish(new Error('DoH resolver returned an unexpected status')); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > DOH_MAX_RESPONSE_BYTES) { response.destroy(); finish(new Error('DoH response too large')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => finish(undefined, Buffer.concat(chunks)));
      response.on('error', error => finish(error));
    });
    const timer = setTimeout(() => {
      req.destroy(Object.assign(new Error('DoH query timed out'), { code: 'ETIMEDOUT' }));
    }, DOH_QUERY_TIMEOUT_MS);
    req.once('error', error => finish(error));
    req.end();
  });
}

const retryableConnectionCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'EADDRNOTAVAIL', 'EPIPE']);
export const ATTACHMENT_CONNECTION_TIMEOUT_MS = 3_000;

async function openPinnedResponse(url: URL, pinned: LookupAddress, signal: AbortSignal): Promise<IncomingMessage> {
  return await new Promise<IncomingMessage>((resolve, reject) => {
    let settled = false;
    // Keep the original URL for Host/SNI/certificate validation, but never resolve DNS a second time.
    const req = request(url, {
      method: 'GET', agent: false, signal, family: pinned.family, rejectUnauthorized: true,
      maxHeaderSize: 16 * 1024,
      headers: { 'Accept-Encoding': 'identity' },
      lookup: (_host, options, callback) => {
        if (options.all) callback(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      },
    }, response => {
      // Abort may arrive while the caller is preparing the destination, before pipeline owns the stream.
      response.on('error', () => undefined);
      if (settled) { response.destroy(); return; }
      settled = true;
      clearTimeout(timer);
      resolve(response);
    });
    const timer = setTimeout(() => {
      req.destroy(Object.assign(new Error('Connection attempt timed out'), { code: 'ETIMEDOUT' }));
    }, ATTACHMENT_CONNECTION_TIMEOUT_MS);
    req.once('error', error => {
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    req.end();
  });
}

/** Returns an undecoded byte stream. The caller owns consuming or destroying it. */
export async function downloadAttachment(value: string, signal: AbortSignal): Promise<IncomingMessage> {
  let url = attachmentUrl(value);
  for (let redirects = 0; redirects <= 3; redirects++) {
    let response: IncomingMessage;
    try { response = await openResponse(url, signal); }
    catch (error) {
      if (signal.aborted) throw new AppError('TIMEOUT', '附件保存已取消或超时');
      if (error instanceof AppError) throw error;
      throw new AppError('DOWNLOAD_FAILED', '无法下载附件，请获取新的文件下载地址后重试');
    }
    const status = response.statusCode;
    if (status !== undefined && [301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers.location;
      response.destroy();
      if (!location || redirects === 3) throw new AppError('DOWNLOAD_FAILED', '附件下载重定向无效或次数过多');
      try { url = attachmentUrl(new URL(location, url).href); }
      catch (error) { if (error instanceof AppError) throw error; throw new AppError('DOWNLOAD_BLOCKED', '附件重定向地址无效'); }
      continue;
    }
    if (status !== 200 || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
      response.destroy();
      throw new AppError('DOWNLOAD_FAILED', '附件下载响应无效或链接已失效，请获取新的文件下载地址后重试');
    }
    const length = response.headers['content-length'];
    if (length !== undefined && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)))) {
      response.destroy(); throw new AppError('DOWNLOAD_FAILED', '附件响应长度无效');
    }
    if (length !== undefined && Number(length) > MAX_ATTACHMENT_BYTES) {
      response.destroy(); throw new AppError('FILE_TOO_LARGE', '附件超过 20 MiB 限制');
    }
    return response;
  }
  throw new AppError('DOWNLOAD_FAILED', '附件下载重定向次数过多');
}
