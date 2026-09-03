import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { AppError } from '../shared/errors.js';
import { isSensitive } from './sensitive-file-policy.js';
import type { IgnorePolicy } from './ignore-policy.js';

export interface ResolvedPath { absolute: string; relative: string; stat: Awaited<ReturnType<typeof lstat>> }
export interface CreatablePath { absolute: string; relative: string }

export class PathPolicy {
  constructor(readonly root: string, readonly ignore: IgnorePolicy) {}
  async resolve(input: string, options: { allowDirectory?: boolean; allowIgnored?: boolean } = {}): Promise<ResolvedPath> {
    if (path.isAbsolute(input) || input.includes('\0')) throw new AppError('PATH_OUTSIDE_WORKSPACE', '仅允许 workspace 相对路径');
    let decoded: string;
    try { decoded = decodeURIComponent(input); } catch { throw new AppError('INVALID_INPUT', '路径编码无效'); }
    const candidate = path.resolve(this.root, decoded);
    if (!this.#inside(candidate)) throw new AppError('PATH_OUTSIDE_WORKSPACE', '路径位于 workspace 之外');
    let canonical: string;
    try { canonical = await realpath(candidate); } catch { throw new AppError('FILE_NOT_FOUND', '目标不存在'); }
    if (!this.#inside(canonical)) throw new AppError('PATH_OUTSIDE_WORKSPACE', '符号链接指向 workspace 之外');
    const relative = path.relative(this.root, canonical).replaceAll(path.sep, '/') || '.';
    this.#assertAllowed(relative, options.allowIgnored);
    const stat = await lstat(candidate);
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
    try { await lstat(candidate); throw new AppError('INVALID_INPUT', '创建目标已存在'); } catch (error) { if (error instanceof AppError) throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AppError('PATH_BLOCKED', '无法安全检查创建目标'); }
    return { absolute: path.join(parent, path.basename(candidate)), relative };
  }
  #decode(input: string): string {
    if (path.isAbsolute(input) || input.includes('\0')) throw new AppError('PATH_OUTSIDE_WORKSPACE', '仅允许 workspace 相对路径');
    try { return decodeURIComponent(input); } catch { throw new AppError('INVALID_INPUT', '路径编码无效'); }
  }
  #assertAllowed(relative: string, allowIgnored = false): void {
    const normalized = relative.replaceAll('\\', '/');
    if (normalized === '.git' || normalized.startsWith('.git/') || normalized === '.chatgpt-mcp-bridge-ignore') throw new AppError('PATH_BLOCKED', '受保护的 Bridge/Git 路径不可访问');
    if (isSensitive(normalized)) throw new AppError('SENSITIVE_FILE', '敏感文件策略禁止访问该路径');
    if (!allowIgnored && this.ignore.isIgnored(normalized)) throw new AppError('PATH_BLOCKED', 'ignore 策略禁止访问该路径');
  }
  #inside(candidate: string): boolean { const rel = path.relative(this.root, candidate); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); }
}
