import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { link, open, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { AttachmentService } from '../../src/workspace/attachment-service.js';
import { WorkspaceContext } from '../../src/workspace/workspace-context.js';
import { MutationCoordinator } from '../../src/security/mutation-coordinator.js';
import { downloadAttachment } from '../../src/attachment/download.js';
import type * as DownloadModule from '../../src/attachment/download.js';
import { ATTACHMENT_TIMEOUT_MS, MAX_ATTACHMENT_BYTES } from '../../src/attachment/schemas.js';
import { PatchService } from '../../src/workspace/patch-service.js';

import type * as FsModule from 'node:fs/promises';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, link: vi.fn(actual.link), open: vi.fn(actual.open), rm: vi.fn(actual.rm) };
});

vi.mock('../../src/attachment/download.js', async importOriginal => ({
  ...await importOriginal<typeof DownloadModule>(),
  downloadAttachment: vi.fn(),
}));

const file = { file_id: 'file-test', download_url: 'https://files.example.org/image?secret=DO-NOT-LOG', file_name: '../../untrusted.png' };
const signal = (): AbortSignal => new AbortController().signal;
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
function response(chunks: Buffer[], length?: number): IncomingMessage {
  return Object.assign(Readable.from(chunks), { headers: length === undefined ? {} : { 'content-length': String(length) }, statusCode: 200 }) as IncomingMessage;
}

describe('附件保存与文件安全', () => {
  let directory: string; let root: string; let workspace: WorkspaceContext; let coordinator: MutationCoordinator; let service: AttachmentService;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'bridge-attachment-')); root = path.join(directory, 'repo'); await mkdir(root);
    await writeFile(path.join(root, '.chatgpt-mcp-bridge-ignore'), 'private-dir/**\nignored.pdf\n');
    workspace = await WorkspaceContext.create(root); coordinator = new MutationCoordinator(); service = new AttachmentService(workspace, coordinator);
    vi.mocked(downloadAttachment).mockReset().mockImplementation(() => Promise.resolve(response([Buffer.from([0, 1, 255, 13, 10])])));
  });
  afterEach(async () => { vi.useRealTimers(); await coordinator.run(() => Promise.resolve()); await rm(directory, { recursive: true, force: true }); });

  it.each(['png', 'pdf', 'docx', 'xlsx'])('原样保存 %s 字节，创建中文父目录并返回哈希', async extension => {
    const bytes = Buffer.from([0, 255, 254, 13, 10, 80, 75, 3, 4]);
    vi.mocked(downloadAttachment).mockResolvedValueOnce(response([bytes.subarray(0, 3), bytes.subarray(3)], bytes.length));
    const target = `附件/图片/result.${extension}`;
    expect(await service.save({ file, path: target }, signal())).toEqual({ path: target, bytes: bytes.length, sha256: digest(bytes) });
    expect(await readFile(path.join(root, target))).toEqual(bytes);
    expect(await readdir(path.join(root, '附件/图片'))).toEqual([`result.${extension}`]);
    await expect(readFile(path.join(directory, 'untrusted.png'))).rejects.toThrow();
  });

  it('零字节附件和编码百分号路径保持完整', async () => {
    vi.mocked(downloadAttachment).mockResolvedValueOnce(response([], 0));
    const result = await service.save({ file, path: '100%25/image.png' }, signal());
    expect(result).toEqual({ path: '100%/image.png', bytes: 0, sha256: digest(Buffer.alloc(0)) });
    expect(await readdir(path.join(root, '100%'))).toEqual(['image.png']);
  });

  it('恰好 20 MiB 成功，多一个字节失败并清理临时文件', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 137); const chunks = Array.from({ length: 20 }, () => chunk);
    vi.mocked(downloadAttachment).mockResolvedValueOnce(response(chunks, MAX_ATTACHMENT_BYTES));
    expect((await service.save({ file, path: 'limit.png' }, signal())).bytes).toBe(MAX_ATTACHMENT_BYTES);
    expect(digest(await readFile(path.join(root, 'limit.png')))).toBe(digest(Buffer.concat(chunks)));
    vi.mocked(downloadAttachment).mockResolvedValueOnce(response([...chunks, Buffer.from([0])]));
    await expect(service.save({ file, path: 'oversize.png' }, signal())).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(await readdir(root)).toEqual(['.chatgpt-mcp-bridge-ignore', 'limit.png']);
  });

  it.each([
    ['../outside.png', 'PATH_OUTSIDE_WORKSPACE'], ['%2e%2e/outside.png', 'PATH_OUTSIDE_WORKSPACE'],
    ['/tmp/outside.png', 'PATH_OUTSIDE_WORKSPACE'], ['%2ftmp/outside.png', 'PATH_OUTSIDE_WORKSPACE'],
    ['C:\\outside.png', 'PATH_OUTSIDE_WORKSPACE'], ['a%00.png', 'PATH_OUTSIDE_WORKSPACE'],
    ['.env', 'SENSITIVE_FILE'], ['private.key', 'SENSITIVE_FILE'], ['.env/sub/file.png', 'SENSITIVE_FILE'],
    ['.git/objects/image.png', 'PATH_BLOCKED'], ['.chatgpt-mcp-bridge/mcp.json', 'PATH_BLOCKED'],
    ['.chatgpt-mcp-bridge-ignore', 'PATH_BLOCKED'], ['private-dir/image.png', 'PATH_BLOCKED'],
    ['ignored.pdf', 'PATH_BLOCKED'], ['bundle.zip', 'PATH_BLOCKED'], ['dist/image.png', 'PATH_BLOCKED'],
    ['nul.png', 'INVALID_INPUT'], ['images./file.png', 'INVALID_INPUT'], ['image.png:stream', 'PATH_OUTSIDE_WORKSPACE'],
  ])('下载前拒绝路径 %s', async (target, code) => {
    await expect(service.save({ file, path: target }, signal())).rejects.toMatchObject({ code });
    expect(downloadAttachment).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(['.chatgpt-mcp-bridge-ignore']);
  });

  it('输入缺少字段或包含额外参数时拒绝', async () => {
    for (const input of [{ file, path: 'a.png', overwrite: true }, { file: { download_url: file.download_url }, path: 'a.png' }, { file: { ...file, headers: {} }, path: 'a.png' }]) {
      await expect(service.save(input, signal())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(downloadAttachment).not.toHaveBeenCalled();
  });

  it('并发同名创建只有一次成功，不覆盖旧文件', async () => {
    const results = await Promise.allSettled([service.save({ file, path: 'a.png' }, signal()), service.save({ file, path: 'a.png' }, signal())]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'FILE_CONFLICT' } });
    const before = await readFile(path.join(root, 'a.png'));
    await expect(service.save({ file, path: 'a.png' }, signal())).rejects.toMatchObject({ code: 'FILE_CONFLICT' });
    expect(await readFile(path.join(root, 'a.png'))).toEqual(before); expect(downloadAttachment).toHaveBeenCalledTimes(1);
  });

  it('安全目录链接可用，越界、悬空、敏感、忽略和配置目录别名不可用', async () => {
    await mkdir(path.join(root, 'safe')); await symlink('safe', path.join(root, 'safe-link'));
    expect((await service.save({ file, path: 'safe-link/a.png' }, signal())).path).toBe('safe/a.png');
    for (const [target, code] of [[directory, 'PATH_OUTSIDE_WORKSPACE'], ['missing', 'PATH_BLOCKED'], ['.env', 'SENSITIVE_FILE'], ['private-dir', 'PATH_BLOCKED'], ['.chatgpt-mcp-bridge', 'PATH_BLOCKED']] as const) {
      if (!path.isAbsolute(target) && target !== 'missing') await mkdir(path.join(root, target));
      const name = `alias-${code}-${path.basename(target)}`; await symlink(target, path.join(root, name));
      await expect(service.save({ file, path: `${name}/a.png` }, signal())).rejects.toMatchObject({ code });
    }
    await writeFile(path.join(root, 'plain'), 'text');
    await expect(service.save({ file, path: 'plain/a.png' }, signal())).rejects.toMatchObject({ code: 'PATH_BLOCKED' });
  });

  it('补丁创建不能利用目录别名绕过真实目标策略', async () => {
    await mkdir(path.join(root, '.chatgpt-mcp-bridge')); await symlink('.chatgpt-mcp-bridge', path.join(root, 'config-alias'));
    await expect(new PatchService(workspace, coordinator).apply({ operation: 'create_file', path: 'config-alias/mcp.json', diff: '--- /dev/null\n+++ b/a\n@@ -0,0 +1 @@\n+{}\n' })).rejects.toMatchObject({ code: 'PATH_BLOCKED' });
  });

  it('下载中途另一进程创建目标时保留其文件', async () => {
    const stream = Readable.from((async function* () { yield Buffer.from('first'); await writeFile(path.join(root, 'race.png'), 'keep'); yield Buffer.from('second'); })());
    vi.mocked(downloadAttachment).mockResolvedValueOnce(Object.assign(stream, { headers: {} }) as IncomingMessage);
    await expect(service.save({ file, path: 'race.png' }, signal())).rejects.toMatchObject({ code: 'FILE_CONFLICT' });
    expect(await readFile(path.join(root, 'race.png'), 'utf8')).toBe('keep');
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('下载中目录别名转向外部时拒绝提交', async () => {
    await mkdir(path.join(root, 'safe')); await symlink('safe', path.join(root, 'alias'));
    const stream = Readable.from((async function* () { yield Buffer.from('first'); await rm(path.join(root, 'alias')); await symlink(directory, path.join(root, 'alias')); yield Buffer.from('second'); })());
    vi.mocked(downloadAttachment).mockResolvedValueOnce(Object.assign(stream, { headers: {} }) as IncomingMessage);
    await expect(service.save({ file, path: 'alias/race.png' }, signal())).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
    expect(await readdir(path.join(root, 'safe'))).toEqual([]); await expect(readFile(path.join(directory, 'race.png'))).rejects.toThrow();
  });

  it('截断或读取错误不产生目标，错误不泄露下载凭据', async () => {
    vi.mocked(downloadAttachment).mockResolvedValueOnce(response([Buffer.from('x')], 2));
    await expect(service.save({ file, path: 'short.png' }, signal())).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
    const stream = Readable.from((async function* () { yield Buffer.from('partial'); await Promise.resolve(); throw new Error(file.download_url); })());
    vi.mocked(downloadAttachment).mockResolvedValueOnce(Object.assign(stream, { headers: {} }) as IncomingMessage);
    const broken = service.save({ file, path: 'broken.png' }, signal());
    await expect(broken).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
    await expect(broken).rejects.not.toThrow('DO-NOT-LOG');
    expect(await readdir(root)).toEqual(['.chatgpt-mcp-bridge-ignore']);
  });

  it('取消流式传输后清理部分文件并释放写入队列', async () => {
    const controller = new AbortController(); const stream = new Readable({ read() { this.push(Buffer.from('partial')); this._read = () => undefined; } });
    vi.mocked(downloadAttachment).mockResolvedValueOnce(Object.assign(stream, { headers: {} }) as IncomingMessage);
    const pending = service.save({ file, path: 'cancelled.png' }, controller.signal);
    await vi.waitFor(() => expect(stream.readableDidRead).toBe(true)); controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    await coordinator.run(() => Promise.resolve());
    expect(stream.destroyed).toBe(true); expect(await readdir(root)).toEqual(['.chatgpt-mcp-bridge-ignore']);
    expect((await service.save({ file, path: 'next.png' }, signal())).bytes).toBe(5);
  });

  it.each(['success', 'conflict', 'failure'] as const)('link 提交期间取消保留实际结果：%s', async outcome => {
    const actual = await vi.importActual<typeof FsModule>('node:fs/promises');
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(link).mockImplementationOnce(async (source, destination) => {
      entered(); await gate;
      if (outcome === 'conflict') await writeFile(destination, 'keep');
      if (outcome === 'failure') throw Object.assign(new Error('disk failure'), { code: 'EIO' });
      await actual.link(source, destination);
    });
    const controller = new AbortController(); let settled = false;
    const pending = service.save({ file, path: 'commit.png' }, controller.signal);
    const observed = pending.then(value => { settled = true; return { value }; }, (error: unknown) => { settled = true; return { error }; });
    try {
      await started; controller.abort(); await new Promise(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
    } finally { release(); }
    const result = await observed;
    if (outcome === 'success') {
      expect(result).toMatchObject({ value: { path: 'commit.png', bytes: 5 } });
      expect((await readFile(path.join(root, 'commit.png'))).length).toBe(5);
    } else {
      expect(result).toMatchObject({ error: { code: outcome === 'conflict' ? 'FILE_CONFLICT' : 'DOWNLOAD_FAILED' } });
      if (outcome === 'conflict') expect(await readFile(path.join(root, 'commit.png'), 'utf8')).toBe('keep');
      else await expect(readFile(path.join(root, 'commit.png'))).rejects.toThrow();
    }
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('关闭临时文件期间取消不会发布目标', async () => {
    const actual = await vi.importActual<typeof FsModule>('node:fs/promises');
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args); const close = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementationOnce(async () => { entered(); await gate; await close(); });
      return handle;
    });
    const controller = new AbortController();
    const checked = expect(service.save({ file, path: 'close.png' }, controller.signal)).rejects.toMatchObject({ code: 'TIMEOUT' });
    try { await started; controller.abort(); await checked; } finally { release(); }
    await coordinator.run(() => Promise.resolve());
    expect(await readdir(root)).toEqual(['.chatgpt-mcp-bridge-ignore']);
  });

  it('提交成功后的临时文件清理期间取消仍返回成功', async () => {
    const actual = await vi.importActual<typeof FsModule>('node:fs/promises');
    const controller = new AbortController();
    vi.mocked(rm).mockImplementationOnce(async (...args) => {
      expect((await readFile(path.join(root, 'cleanup.png'))).length).toBe(5);
      controller.abort(); await new Promise(resolve => setImmediate(resolve)); await actual.rm(...args);
    });
    await expect(service.save({ file, path: 'cleanup.png' }, controller.signal)).resolves.toMatchObject({ path: 'cleanup.png', bytes: 5 });
    expect(await readdir(root)).toEqual(['.chatgpt-mcp-bridge-ignore', 'cleanup.png']);
  });

  it('等待互斥队列期间超时，不会稍后执行已取消的保存', async () => {
    let release!: () => void;
    const blocker = coordinator.run(async () => { await new Promise<void>(resolve => { release = resolve; }); });
    await Promise.resolve(); vi.useFakeTimers();
    const pending = expect(service.save({ file, path: 'late.png' }, signal())).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(ATTACHMENT_TIMEOUT_MS); await pending; vi.useRealTimers();
    release(); await blocker; await coordinator.run(() => Promise.resolve());
    expect(downloadAttachment).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual(['.chatgpt-mcp-bridge-ignore']);
  });
});
