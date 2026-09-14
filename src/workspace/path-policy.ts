import path from 'node:path';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { AppError } from '../shared/errors.js';
import { isSensitive } from './sensitive-file-policy.js';
import type { IgnorePolicy } from './ignore-policy.js';

export interface ResolvedPath { absolute: string; relative: string; stat: Awaited<ReturnType<typeof lstat>> }
export interface CreatablePath { absolute: string; relative: string }

export class PathPolicy {
  constructor(readonly root: string, readonly ignore: IgnorePolicy) {}
  async resolve(input: string, options: { allowDirectory?: boolean; allowIgnored?: boolean; allowBridgeConfig?: boolean } = {}): Promise<ResolvedPath> {
    if (path.isAbsolute(input) || input.includes('\0')) throw new AppError('PATH_OUTSIDE_WORKSPACE', '仅允许 workspace 相对路径');
    let decoded: string;
    try { decoded = decodeURIComponent(input); } catch { throw new AppError('INVALID_INPUT', '路径编码无效'); }
    const candidate = path.resolve(this.root, decoded);
    if (!this.#inside(candidate)) throw new AppError('PATH_OUTSIDE_WORKSPACE', '路径位于 workspace 之外');
    try { await lstat(candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await this.#checkMissingAncestors(candidate);
        throw new AppError('FILE_NOT_FOUND', '目标不存在');
      }
      throw new AppError('PATH_BLOCKED', '无法安全检查目标');
    }
    let canonical: string;
    try { canonical = await realpath(candidate); } catch { throw new AppError('PATH_BLOCKED', '无法安全解析目标'); }
    if (!this.#inside(canonical)) throw new AppError('PATH_OUTSIDE_WORKSPACE', '符号链接指向 workspace 之外');
    const relative = path.relative(this.root, canonical).replaceAll(path.sep, '/') || '.';
    this.#assertAllowed(path.relative(this.root, candidate).replaceAll(path.sep, '/') || '.', options.allowIgnored, options.allowBridgeConfig);
    this.#assertAllowed(relative, options.allowIgnored, options.allowBridgeConfig);
    const stat = await lstat(canonical);
    if (!options.allowDirectory && !stat.isFile()) throw new AppError('INVALID_INPUT', '目标不是普通文件');
    return { absolute: canonical, relative, stat };
  }
  async resolveForCreate(input: string): Promise<CreatablePath> {
    const decoded = this.#decode(input); const candidate = path.resolve(this.root, decoded);
    if (!this.#inside(candidate)) throw new AppError('PATH_OUTSIDE_WORKSPACE', '路径位于 workspace 之外');
    const relative = path.relative(this.root, candidate).replaceAll(path.sep, '/'); this.#assertAllowed(relative, false);
    let parent: string;
    try { parent = await realpath(path.dirname(candidate)); } catch { throw new AppError('FILE_NOT_FOUND', '目标父目录不存在'); }
    if (!this.#inside(parent)) throw new AppError('PATH_OUTSIDE_WORKSPACE', '目标父目录位于 workspace 之外');
    this.#assertAllowed(path.relative(this.root, path.join(parent, path.basename(candidate))).replaceAll(path.sep, '/'), false);
    try { await lstat(candidate); throw new AppError('INVALID_INPUT', '创建目标已存在'); } catch (error) { if (error instanceof AppError) throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AppError('PATH_BLOCKED', '无法安全检查创建目标'); }
    return { absolute: path.join(parent, path.basename(candidate)), relative };
  }
  /** Attachment creation validates every lexical and canonical ancestor, including missing directories. */
  async resolveForAttachment(input: string, createParents = false, signal?: AbortSignal): Promise<CreatablePath> {
    const decoded = this.#decode(input);
    if (decoded.includes('\\') || decoded.includes(':') || decoded.split('/').includes('..')) throw new AppError('PATH_OUTSIDE_WORKSPACE', '附件路径必须是工作区内的相对路径');
    const parts = decoded.split('/');
    if (parts.some(part => !part || part === '.' || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) throw new AppError('INVALID_INPUT', '附件路径包含不支持的名称');
    for (let i = 1; i <= parts.length; i++) this.#assertAllowed(parts.slice(0, i).join('/'));
    let current = this.root;
    for (let i = 0; i < parts.length; i++) {
      signal?.throwIfAborted();
      const part = parts[i]; if (part === undefined) throw new AppError('INVALID_INPUT', '附件路径无效');
      const candidate = path.join(current, part);
      this.#assertAllowed(path.relative(this.root, candidate).replaceAll(path.sep, '/'));
      let info;
      try { info = await lstat(candidate); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AppError('PATH_BLOCKED', '无法检查附件路径'); }
      if (i === parts.length - 1) {
        if (info) throw new AppError('FILE_CONFLICT', '目标已存在，请选择其他文件名');
        return { absolute: candidate, relative: path.relative(this.root, candidate).replaceAll(path.sep, '/') };
      }
      if (!info) {
        if (!createParents) { current = candidate; continue; }
        signal?.throwIfAborted();
        try { await mkdir(candidate, { mode: 0o755 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new AppError('PATH_BLOCKED', '无法创建附件父目录'); }
      }
      let canonical: string;
      try { canonical = await realpath(candidate); } catch { throw new AppError('PATH_BLOCKED', '无法解析附件父目录'); }
      if (!this.#inside(canonical)) throw new AppError('PATH_OUTSIDE_WORKSPACE', '附件父目录位于 workspace 之外');
      // Check canonical ancestors too: an alias must not enter a sensitive or ignored directory.
      const canonicalParts = path.relative(this.root, canonical).split(path.sep).filter(Boolean);
      for (let j = 1; j <= canonicalParts.length; j++) this.#assertAllowed(canonicalParts.slice(0, j).join('/'));
      if (!(await lstat(canonical)).isDirectory()) throw new AppError('PATH_BLOCKED', '附件父路径不是目录');
      current = canonical;
    }
    throw new AppError('INVALID_INPUT', '附件路径无效');
  }
  async #checkMissingAncestors(candidate: string): Promise<void> {
    // Windows can report ENOENT when an ancestor is a file rather than a directory.
    let ancestor = path.dirname(candidate);
    while (this.#inside(ancestor)) {
      try { await lstat(ancestor); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || ancestor === this.root) throw new AppError('PATH_BLOCKED', '无法安全检查父目录');
        ancestor = path.dirname(ancestor);
        continue;
      }
      let canonical: string;
      try { canonical = await realpath(ancestor); } catch { throw new AppError('PATH_BLOCKED', '无法安全解析父目录'); }
      if (!this.#inside(canonical)) throw new AppError('PATH_OUTSIDE_WORKSPACE', '父目录符号链接指向 workspace 之外');
      try { if ((await lstat(canonical)).isDirectory()) return; } catch { /* Reject inaccessible ancestors below. */ }
      throw new AppError('PATH_BLOCKED', '目标父路径不是可访问目录');
    }
    throw new AppError('PATH_BLOCKED', '无法安全检查父目录');
  }
  #decode(input: string): string {
    if (path.isAbsolute(input) || input.includes('\0')) throw new AppError('PATH_OUTSIDE_WORKSPACE', '仅允许 workspace 相对路径');
    let decoded: string;
    try { decoded = decodeURIComponent(input); } catch { throw new AppError('INVALID_INPUT', '路径编码无效'); }
    if (path.isAbsolute(decoded) || path.win32.isAbsolute(decoded) || decoded.includes('\0')) throw new AppError('PATH_OUTSIDE_WORKSPACE', '仅允许 workspace 相对路径');
    return decoded;
  }
  #assertAllowed(relative: string, allowIgnored = false, allowBridgeConfig = false): void {
    const normalized = relative.replaceAll('\\', '/');
    const bridgeConfig = normalized === '.chatgpt-mcp-bridge' || normalized.startsWith('.chatgpt-mcp-bridge/');
    if (normalized === '.git' || normalized.startsWith('.git/') || normalized === '.chatgpt-mcp-bridge-ignore' || (bridgeConfig && !allowBridgeConfig)) throw new AppError('PATH_BLOCKED', '受保护的 Bridge/Git 路径不可访问');
    if (isSensitive(normalized)) throw new AppError('SENSITIVE_FILE', '敏感文件策略禁止访问该路径');
    if (!allowIgnored && this.ignore.isIgnored(normalized)) throw new AppError('PATH_BLOCKED', 'ignore 策略禁止访问该路径');
  }
  #inside(candidate: string): boolean { const rel = path.relative(this.root, candidate); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); }
}
