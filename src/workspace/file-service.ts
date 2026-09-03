import { open, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../shared/errors.js';
import { MAX_FILE_BYTES } from '../shared/constants.js';
import { requestDigest } from '../security/output-limiter.js';
import { sha256 } from './patch-service.js';
import { isSensitive } from './sensitive-file-policy.js';
import type { WorkspaceContext } from './workspace-context.js';

export class FileService {
  constructor(private readonly workspace: WorkspaceContext, private readonly maxFileBytes = MAX_FILE_BYTES) {}
  async read(input: { path: string; startLine?: number; endLine?: number; maxLines?: number; cursor?: string }, allowIgnored = false): Promise<Record<string, unknown>> {
    const resolved = await this.workspace.paths.resolve(input.path, { allowIgnored });
    if (resolved.stat.size > this.maxFileBytes) throw new AppError('FILE_TOO_LARGE', `文件超过 ${this.maxFileBytes} 字节限制`);
    const handle = await open(resolved.absolute, 'r'); const sample = Buffer.alloc(Math.min(Number(resolved.stat.size), 8192));
    try { await handle.read(sample, 0, sample.length, 0); } finally { await handle.close(); }
    if (sample.includes(0)) throw new AppError('BINARY_FILE', '拒绝读取二进制文件正文');
    const content = await readFile(resolved.absolute, 'utf8');
    if (content.includes('\uFFFD')) throw new AppError('BINARY_FILE', '文件不是可安全识别的 UTF-8 文本');
    const lines = content.split(/\r?\n/u); if (content.endsWith('\n')) lines.pop();
    const digest = requestDigest({ path: resolved.relative, startLine: input.startLine, endLine: input.endLine, maxLines: input.maxLines });
    const requestedStart = input.cursor ? this.workspace.cursors.verify(input.cursor, 'read_file', digest) + 1 : (input.startLine ?? 1);
    const maximumEnd = Math.min(input.endLine ?? lines.length, requestedStart + Math.min(input.maxLines ?? 300, 500) - 1, lines.length);
    const numbered = lines.slice(requestedStart - 1, maximumEnd).map((line, index) => `${requestedStart + index}: ${line}`).join('\n');
    const truncated = maximumEnd < Math.min(input.endLine ?? lines.length, lines.length);
    return { path: resolved.relative, sha256: sha256(content), content: numbered, totalLines: lines.length, startLine: requestedStart, endLine: maximumEnd, truncated, ...(truncated ? { nextCursor: this.workspace.cursors.sign('read_file', maximumEnd, digest) } : {}) };
  }
  async list(input: { path?: string; depth?: number; maxEntries?: number; cursor?: string }): Promise<Record<string, unknown>> {
    const resolved = await this.workspace.paths.resolve(input.path ?? '.', { allowDirectory: true, allowIgnored: true });
    if (!resolved.stat.isDirectory()) throw new AppError('INVALID_INPUT', '目标不是目录');
    const all: Array<Record<string, unknown>> = []; await this.#walk(resolved.absolute, input.depth ?? 1, all);
    all.sort((a, b) => String(a['path']).localeCompare(String(b['path'])));
    const digest = requestDigest({ path: resolved.relative, depth: input.depth }); const offset = input.cursor ? this.workspace.cursors.verify(input.cursor, 'list_directory', digest) : 0;
    const limit = Math.min(input.maxEntries ?? 200, 500); const entries = all.slice(offset, offset + limit); const next = offset + entries.length; const truncated = next < all.length;
    return { path: resolved.relative, entries, truncated, ...(truncated ? { nextCursor: this.workspace.cursors.sign('list_directory', next, digest) } : {}) };
  }
  async #walk(directory: string, depth: number, result: Array<Record<string, unknown>>): Promise<void> {
    if (depth < 1 || result.length >= 5000) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name); const relative = path.relative(this.workspace.root, absolute).replaceAll(path.sep, '/');
      const ignored = this.workspace.ignore.isIgnored(relative); const sensitive = isSensitive(relative); const type = entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file';
      let readable = !ignored && !sensitive; let blockedReason: string | undefined; let size: number | undefined;
      if (!readable) blockedReason = sensitive ? 'SENSITIVE_FILE' : 'PATH_BLOCKED';
      try { const checked = await this.workspace.paths.resolve(relative, { allowDirectory: true, allowIgnored: true }); size = Number(checked.stat.size); } catch (error) { readable = false; blockedReason = error instanceof AppError ? error.code : 'PATH_BLOCKED'; }
      result.push({ path: relative, type, ...(size === undefined ? {} : { size }), ignored, readable, ...(blockedReason ? { blockedReason } : {}) });
      if (entry.isDirectory() && !ignored && !sensitive) await this.#walk(absolute, depth - 1, result);
    }
  }
}
