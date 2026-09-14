import { createHash, randomUUID } from 'node:crypto';
import { link, open, rm } from 'node:fs/promises';
import type { lstat } from 'node:fs/promises';
import path from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { attachmentInputSchema, ATTACHMENT_TIMEOUT_MS, MAX_ATTACHMENT_BYTES, type AttachmentResult } from '../attachment/schemas.js';
import { attachmentUrl, downloadAttachment } from '../attachment/download.js';
import type { MutationCoordinator } from '../security/mutation-coordinator.js';
import { abortable } from '../shared/abort.js';
import { AppError } from '../shared/errors.js';
import type { WorkspaceContext } from './workspace-context.js';

export class AttachmentService {
  constructor(private readonly workspace: WorkspaceContext, private readonly coordinator: MutationCoordinator) {}

  async save(input: unknown, callerSignal: AbortSignal): Promise<AttachmentResult> {
    const parsed = attachmentInputSchema.safeParse(input);
    if (!parsed.success) throw new AppError('INVALID_INPUT', '附件输入无效');
    const deadline = new AbortController();
    const signal = AbortSignal.any([callerSignal, deadline.signal]);
    const timer = setTimeout(() => { deadline.abort(); }, ATTACHMENT_TIMEOUT_MS);
    // Only preparation races cancellation. Publication has an authoritative filesystem outcome.
    const preparation = new AbortController();
    const onAbort = () => { preparation.abort(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    const state = { committing: false };
    try {
      return await abortable(this.coordinator.run(async () => {
        signal.throwIfAborted();
        const { file, path: target } = parsed.data;
        attachmentUrl(file.download_url);
        await this.workspace.paths.resolveForAttachment(target);
        const response = await downloadAttachment(file.download_url, signal);
        let temporary: string | undefined;
        let temporaryIdentity: Awaited<ReturnType<typeof lstat>> | undefined;
        try {
          signal.throwIfAborted();
          const resolved = await this.workspace.paths.resolveForAttachment(target, true, signal);
          const parent = await this.workspace.paths.resolve(encoded(path.posix.dirname(resolved.relative)), { allowDirectory: true });
          const tempInput = encoded(path.posix.join(path.posix.dirname(resolved.relative), `.chatgpt-mcp-bridge-${randomUUID()}.tmp`));
          const tempPath = await this.workspace.paths.resolveForAttachment(tempInput);
          signal.throwIfAborted();
          const handle = await open(tempPath.absolute, 'wx', 0o600);
          temporary = tempInput;
          let closed = false;
          try {
            temporaryIdentity = await handle.stat();
            let bytes = 0; const hash = createHash('sha256');
            const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
              bytes += chunk.length;
              if (bytes > MAX_ATTACHMENT_BYTES) { callback(new AppError('FILE_TOO_LARGE', '附件超过 20 MiB 限制')); return; }
              hash.update(chunk); callback(null, chunk);
            } });
            // Own the file descriptor explicitly: pipeline must not wait for a FileHandle stream's close event.
            const sink = new Writable({ write(chunk: Buffer, _encoding, callback) {
              void handle.writeFile(chunk).then(() => { callback(); }, (error: unknown) => { callback(error instanceof Error ? error : new Error('File write failed')); });
            } });
            await pipeline(response, counter, sink, { signal });
            const expected = response.headers['content-length'];
            if (expected !== undefined && bytes !== Number(expected)) throw new AppError('DOWNLOAD_FAILED', '附件传输不完整，请重试');
            await handle.sync();
            await handle.close();
            closed = true;
            const finalPath = await this.workspace.paths.resolveForAttachment(target);
            const finalParent = await this.workspace.paths.resolve(encoded(path.posix.dirname(resolved.relative)), { allowDirectory: true });
            const finalTemp = await this.workspace.paths.resolve(tempInput);
            if (finalPath.absolute !== resolved.absolute || finalParent.stat.dev !== parent.stat.dev || finalParent.stat.ino !== parent.stat.ino || finalTemp.stat.dev !== temporaryIdentity.dev || finalTemp.stat.ino !== temporaryIdentity.ino) throw new AppError('PATH_BLOCKED', '附件保存期间路径已变化');
            signal.throwIfAborted();
            state.committing = true;
            signal.removeEventListener('abort', onAbort);
            clearTimeout(timer);
            // link is an atomic create-if-absent, unlike rename which would overwrite another file.
            await link(finalTemp.absolute, finalPath.absolute);
            return { path: finalPath.relative, bytes, sha256: hash.digest('hex') };
          } finally { if (!closed) await handle.close(); }
        } finally {
          response.destroy();
          if (temporary && temporaryIdentity) {
            // Never follow a swapped parent or delete a replacement supplied by another process.
            try {
              const existing = await this.workspace.paths.resolve(temporary);
              if (existing.stat.dev === temporaryIdentity.dev && existing.stat.ino === temporaryIdentity.ino) await rm(existing.absolute);
            } catch { /* A removed or externally replaced directory cannot be safely cleaned by pathname. */ }
          }
        }
      }), preparation.signal);
    } catch (error) {
      if (signal.aborted && !state.committing) throw new AppError('TIMEOUT', '附件保存已取消或超时');
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError('FILE_CONFLICT', '目标已存在，请选择其他文件名');
      throw new AppError('DOWNLOAD_FAILED', '附件未能完整保存，请检查目标目录或获取新的下载地址后重试');
    } finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
  }
}

function encoded(relative: string): string { return relative.split('/').map(encodeURIComponent).join('/'); }
