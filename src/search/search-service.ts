import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { runProcess } from '../git/git-runner.js';
import { requestDigest } from '../security/output-limiter.js';
import { isSensitive } from '../workspace/sensitive-file-policy.js';
import type { WorkspaceContext } from '../workspace/workspace-context.js';

interface SearchResult { path: string; line: number; column: number; match: string; context: string[] }

export class SearchService {
  constructor(private readonly workspace: WorkspaceContext) {}
  async search(input: { query: string; isRegex?: boolean; glob?: string | string[]; maxResults?: number; contextLines?: number; caseSensitive?: boolean; cursor?: string }): Promise<Record<string, unknown>> {
    const digest = requestDigest({ ...input, cursor: undefined }); const offset = input.cursor ? this.workspace.cursors.verify(input.cursor, 'search_workspace', digest) : 0;
    const hasRg = await this.#hasRg();
    const all = await (hasRg ? this.#ripgrep(input) : this.#fallback(input));
    const limit = Math.min(input.maxResults ?? 50, 100); const results: SearchResult[] = []; let bytes = 0; for (const item of all.slice(offset, offset + limit)) { const itemBytes = Buffer.byteLength(JSON.stringify(item)); if (bytes + itemBytes > 128 * 1024) break; results.push(item); bytes += itemBytes; } const next = offset + results.length; const truncated = next < all.length;
    return { results, count: results.length, truncated, engine: hasRg ? 'ripgrep' : 'node', ...(truncated ? { nextCursor: this.workspace.cursors.sign('search_workspace', next, digest) } : {}) };
  }
  async #hasRg(): Promise<boolean> { try { await access('/usr/bin/rg', constants.X_OK); return true; } catch { try { await runProcess('rg', ['--version'], this.workspace.root, 4096, 2000, 'SEARCH_TOOL_UNAVAILABLE'); return true; } catch { return false; } } }
  async #ripgrep(input: { query: string; isRegex?: boolean; glob?: string | string[]; contextLines?: number; caseSensitive?: boolean }): Promise<SearchResult[]> {
    const args = ['--json', '--line-number', '--column', '--max-columns=500', '--max-filesize=1M', '--hidden'];
    if (!input.isRegex) args.push('--fixed-strings'); if (!input.caseSensitive) args.push('--ignore-case');
    for (const pattern of ['!.git/**', '!node_modules/**', '!dist/**', '!build/**', '!coverage/**', '!**/.env', '!**/.env.*', '!**/*.pem', '!**/*.key', '!**/*.p12', '!**/*.pfx', '!**/credentials.*', '!**/secrets.*', '!**/application-prod.*', '!**/bootstrap-prod.*', '!**/.npmrc', '!**/.netrc']) args.push('--glob', pattern);
    const globs = typeof input.glob === 'string' ? [input.glob] : (input.glob ?? []); for (const glob of globs) args.push('--glob', glob);
    args.push('--', input.query, '.');
    let output: string; try { output = (await runProcess('rg', args, this.workspace.root, 4 * 1024 * 1024, 10_000, 'SEARCH_TOOL_UNAVAILABLE')).stdout.toString(); } catch (error) { if (error instanceof Error && /操作失败/u.test(error.message)) return []; throw error; }
    const results: SearchResult[] = [];
    for (const line of output.split('\n')) { if (!line) continue; let message: RgMessage; try { message = JSON.parse(line) as RgMessage; } catch { continue; } if (message.type !== 'match' || !message.data) continue;
      const relative = message.data.path.text.replace(/^\.\//u, ''); if (isSensitive(relative) || this.workspace.ignore.isIgnored(relative)) continue;
      const text = message.data.lines.text.replace(/[\r\n]+$/u, '').slice(0, 500); const column = (message.data.submatches[0]?.start ?? 0) + 1;
      results.push({ path: relative, line: message.data.line_number, column, match: text, context: [] }); if (results.length >= 1000) break;
    }
    return results;
  }
  async #fallback(input: { query: string; isRegex?: boolean; glob?: string | string[]; contextLines?: number; caseSensitive?: boolean }): Promise<SearchResult[]> {
    const results: SearchResult[] = []; const flags = input.caseSensitive ? 'u' : 'iu'; const expression = input.isRegex ? new RegExp(input.query, flags) : undefined; await this.#scan(this.workspace.root, input, expression, results); return results;
  }
  async #scan(directory: string, input: { query: string; glob?: string | string[]; caseSensitive?: boolean; contextLines?: number }, expression: RegExp | undefined, results: SearchResult[]): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) { if (results.length >= 1000) return; const absolute = path.join(directory, entry.name); const relative = path.relative(this.workspace.root, absolute).replaceAll(path.sep, '/'); if (isSensitive(relative) || this.workspace.ignore.isIgnored(relative) || entry.isSymbolicLink()) continue; if (entry.isDirectory()) { await this.#scan(absolute, input, expression, results); continue; } if (!matchesGlobs(relative, input.glob)) continue;
      let content: Buffer; try { content = await readFile(absolute); } catch { continue; } if (content.length > 1024 * 1024 || content.subarray(0, 8192).includes(0)) continue; const lines = content.toString('utf8').split(/\r?\n/u);
      for (let index = 0; index < lines.length; index++) { const line = lines[index] ?? ''; const haystack = input.caseSensitive ? line : line.toLowerCase(); const needle = input.caseSensitive ? input.query : input.query.toLowerCase(); const match = expression?.exec(line); const column = expression ? (match?.index ?? -1) : haystack.indexOf(needle); if (column < 0) continue; const radius = input.contextLines ?? 0; results.push({ path: relative, line: index + 1, column: column + 1, match: line.slice(0, 500), context: lines.slice(Math.max(0, index - radius), index + radius + 1).map(value => value.slice(0, 500)) }); }
    }
  }
}

interface RgMessage { type: string; data?: { path: { text: string }; lines: { text: string }; line_number: number; submatches: Array<{ start: number }> } }

export function matchesGlobs(relative: string, globs: string | string[] | undefined): boolean {
  const patterns = typeof globs === 'string' ? [globs] : (globs ?? []); if (patterns.length === 0) return true;
  return patterns.some(pattern => { const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replaceAll('**', '\u0000').replaceAll('*', '[^/]*').replaceAll('?', '[^/]').replaceAll('\u0000', '.*'); return new RegExp(`^(?:${escaped})$`, 'u').test(relative) || (!pattern.includes('/') && new RegExp(`^(?:${escaped})$`, 'u').test(path.basename(relative))); });
}
