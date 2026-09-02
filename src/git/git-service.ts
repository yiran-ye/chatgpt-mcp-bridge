import { lstat, open } from 'node:fs/promises';
import { isSensitive } from '../workspace/sensitive-file-policy.js';
import type { WorkspaceContext } from '../workspace/workspace-context.js';
import { AppError } from '../shared/errors.js';
import { boundedBytes, bytePage, requestDigest } from '../security/output-limiter.js';
import { GitRunner } from './git-runner.js';
import { parseStatus, type ParsedStatus, type StatusFile } from './git-status-parser.js';

export interface SafeStatusFile extends StatusFile { isSensitive: boolean; readable: boolean }
export type SafeParsedStatus = Omit<ParsedStatus, 'files'> & { files: SafeStatusFile[] };

export class GitService {
  readonly runner: GitRunner;
  constructor(private readonly workspace: WorkspaceContext) { this.runner = new GitRunner(workspace.root); }
  async isRepository(): Promise<boolean> { try { return (await this.runner.run(['rev-parse', '--is-inside-work-tree'])).stdout.toString().trim() === 'true'; } catch { return false; } }
  async status(): Promise<SafeParsedStatus> {
    if (!(await this.isRepository())) throw new AppError('NOT_A_GIT_REPOSITORY', 'workspace 不是 Git 仓库');
    const parsed = parseStatus((await this.runner.run(['status', '--porcelain=v2', '-z', '--branch'])).stdout);
    return { ...parsed, files: parsed.files.map(file => ({ ...file, isSensitive: isSensitive(file.path), readable: !isSensitive(file.path) && !this.workspace.ignore.isIgnored(file.path) })) };
  }
  async resolveRef(ref: string): Promise<string> {
    if (!ref || ref.startsWith('-') || /[\u0000-\u0020~^:?*[\\]/u.test(ref)) throw new AppError('INVALID_GIT_REF', 'Git revision 格式无效');
    try { return (await this.runner.run(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).stdout.toString().trim(); }
    catch { throw new AppError('INVALID_GIT_REF', 'Git revision 不存在或不是 commit'); }
  }
  async changedFiles(): Promise<Array<Record<string, unknown>>> {
    const status = await this.status();
    return await Promise.all(status.files.map(async file => {
      let size: number | undefined; let isBinary: boolean | undefined;
      if (file.readable && file.kind !== 'deleted') try { const absolute = `${this.workspace.root}/${file.path}`; const info = await lstat(absolute); size = info.size; const handle = await open(absolute, 'r'); const sample = Buffer.alloc(Math.min(size, 8192)); try { await handle.read(sample, 0, sample.length, 0); } finally { await handle.close(); } isBinary = sample.includes(0); } catch { /* race */ }
      const category = file.kind === 'untracked' ? 'untracked' : file.kind === 'conflicted' ? 'conflicted' : file.indexStatus !== '.' ? 'staged' : 'unstaged';
      return { path: file.path, ...(file.oldPath ? { oldPath: file.oldPath } : {}), category, changeType: file.kind, readable: file.readable, ...(!file.readable ? { blockedReason: file.isSensitive ? 'SENSITIVE_FILE' : 'PATH_BLOCKED' } : {}), ...(size === undefined ? {} : { size }), ...(isBinary === undefined ? {} : { isBinary }) };
    }));
  }
  async diff(input: { scope: 'unstaged' | 'staged' | 'working_tree'; path?: string; contextLines?: number; maxBytes?: number; cursor?: string }): Promise<Record<string, unknown>> {
    if (input.path) await this.validatePathspec(input.path);
    const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', `--unified=${input.contextLines ?? 3}`];
    if (input.scope === 'staged') args.push('--cached'); else if (input.scope === 'working_tree') args.push('HEAD');
    if (input.path) args.push('--', input.path);
    const digest = requestDigest({ ...input, cursor: undefined }); const offset = input.cursor ? this.workspace.cursors.verify(input.cursor, 'git_diff', digest) : 0;
    const patch = (await this.runner.run(args)).stdout.toString('utf8'); const page = bytePage(patch, offset, boundedBytes(input.maxBytes));
    const statArgs = [...args.slice(0, args.indexOf(`--unified=${input.contextLines ?? 3}`)), '--numstat', ...args.slice(args.indexOf(`--unified=${input.contextLines ?? 3}`) + 1)];
    const stats = parseNumstat((await this.runner.run(statArgs)).stdout.toString('utf8'));
    const status = await this.status(); const untracked = status.files.filter(file => file.kind === 'untracked').map(file => file.path);
    return { scope: input.scope, patch: page.text, additions: stats.additions, deletions: stats.deletions, fileCount: stats.files.length, files: stats.files, untracked, truncated: page.nextOffset !== undefined, ...(page.nextOffset === undefined ? {} : { nextCursor: this.workspace.cursors.sign('git_diff', page.nextOffset, digest) }) };
  }
  async compare(input: { base: string; head?: string; mode?: 'merge_base' | 'direct'; path?: string; contextLines?: number; maxBytes?: number; cursor?: string }): Promise<Record<string, unknown>> {
    if (input.path) await this.validatePathspec(input.path);
    const baseCommit = await this.resolveRef(input.base); const headCommit = await this.resolveRef(input.head ?? 'HEAD');
    const mergeBase = (await this.runner.run(['merge-base', baseCommit, headCommit])).stdout.toString().trim();
    const revision = input.mode === 'direct' ? `${baseCommit}..${headCommit}` : `${baseCommit}...${headCommit}`;
    const base = { scope: 'working_tree' as const, contextLines: input.contextLines, maxBytes: input.maxBytes, cursor: input.cursor };
    const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', `--unified=${input.contextLines ?? 3}`, revision]; if (input.path) args.push('--', input.path);
    const digest = requestDigest({ tool: 'git_compare', ...input, cursor: undefined, baseCommit, headCommit }); const offset = input.cursor ? this.workspace.cursors.verify(input.cursor, 'git_compare', digest) : 0;
    const patch = (await this.runner.run(args)).stdout.toString(); const page = bytePage(patch, offset, boundedBytes(base.maxBytes));
    const statArgs = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--numstat', revision]; if (input.path) statArgs.push('--', input.path);
    const stats = parseNumstat((await this.runner.run(statArgs)).stdout.toString());
    return { baseCommit, headCommit, mergeBase, mode: input.mode ?? 'merge_base', patch: page.text, additions: stats.additions, deletions: stats.deletions, fileCount: stats.files.length, files: stats.files, truncated: page.nextOffset !== undefined, ...(page.nextOffset === undefined ? {} : { nextCursor: this.workspace.cursors.sign('git_compare', page.nextOffset, digest) }) };
  }
  async validatePathspec(value: string): Promise<void> { if (value.startsWith('-')) throw new AppError('INVALID_INPUT', 'path 不能以 - 开头'); await this.workspace.paths.resolve(value); }
}

function parseNumstat(value: string): { additions: number; deletions: number; files: string[] } {
  let additions = 0; let deletions = 0; const files: string[] = [];
  for (const line of value.trim().split('\n')) { if (!line) continue; const [add, del, ...rest] = line.split('\t'); additions += Number(add) || 0; deletions += Number(del) || 0; files.push(rest.join('\t')); }
  return { additions, deletions, files };
}
