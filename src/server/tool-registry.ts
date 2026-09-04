import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { COMMAND_ANNOTATIONS, READ_ONLY_ANNOTATIONS, WRITE_ANNOTATIONS } from '../shared/constants.js';
import { AppError, safeError } from '../shared/errors.js';
import type { WorkspaceContext } from '../workspace/workspace-context.js';
import { FileService } from '../workspace/file-service.js';
import { GitService } from '../git/git-service.js';
import { SearchService } from '../search/search-service.js';
import type { AuditLogger } from '../security/audit-logger.js';
import { isSensitive } from '../workspace/sensitive-file-policy.js';
import { boundedBytes, bytePage, requestDigest } from '../security/output-limiter.js';
import type { BridgeOptions } from '../runtime/access.js';
import { effectiveAccess } from '../runtime/access.js';
import { MutationCoordinator } from '../security/mutation-coordinator.js';
import { PatchService, type PatchInput } from '../workspace/patch-service.js';
import { CommandService, FullAccessCommandService } from '../command/command-service.js';

const outputSchema = { data: z.record(z.string(), z.unknown()).describe('结构化工具结果') };
type ToolResult = { content: [{ type: 'text'; text: string }]; structuredContent?: { data: Record<string, unknown> }; isError?: boolean };
type ToolExtra = { signal: AbortSignal };

export function registerTools(server: McpServer, workspace: WorkspaceContext, logger?: AuditLogger, options?: BridgeOptions): void {
  const git = new GitService(workspace); const files = new FileService(workspace); const search = new SearchService(workspace);
  const access = effectiveAccess(options); const coordinator = options?.mutationCoordinator ?? new MutationCoordinator();
  const commands = options?.commandConfig ? new CommandService(workspace, options.commandConfig, coordinator) : undefined;
  const fullAccessCommands = access === 'full-access' ? new FullAccessCommandService(workspace, coordinator) : undefined;
  const wrap = (name: string, action: (input: never, signal: AbortSignal) => Promise<Record<string, unknown>>) => async (input: never, extra: ToolExtra): Promise<ToolResult> => {
    const started = Date.now(); const record = input as unknown as Record<string, unknown>; const rawTarget = typeof record['path'] === 'string' ? record['path'] : typeof record['commandId'] === 'string' ? record['commandId'] : undefined; const target = rawTarget && !path.isAbsolute(rawTarget) && !rawTarget.split(/[\\/]/u).includes('..') ? rawTarget : rawTarget ? '<blocked-path>' : undefined;
    const combined = combineAbortSignals(extra.signal, options?.abortSignal);
    try { const data = await action(input, combined.signal); const text = JSON.stringify(data, null, 2); await logger?.event(name, 'allow', Date.now() - started, Buffer.byteLength(text), undefined, target); return { content: [{ type: 'text', text }], structuredContent: { data } }; }
    catch (error) { const safe = safeError(error); await logger?.event(name, 'deny', Date.now() - started, 0, safe.code, target); return { content: [{ type: 'text', text: JSON.stringify({ error: { code: safe.code, message: safe.message } }) }], isError: true }; }
    finally { combined.cleanup(); }
  };
  server.registerTool('change_context', { title: '当前改动概况', description: 'Code Review 第一入口：返回 Git 工作区改动统计、文件摘要和项目指令文件，不返回完整 patch。', inputSchema: { includeDiffStat: z.boolean().default(true) }, outputSchema, annotations: READ_ONLY_ANNOTATIONS }, wrap('change_context', async (input: { includeDiffStat: boolean }) => {
    const status = await git.status(); const changed = await git.changedFiles(); let additions = 0; let deletions = 0;
    if (input.includeDiffStat) { const raw = (await git.runner.run(['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--numstat', 'HEAD'])).stdout.toString(); for (const line of raw.split('\n')) { const [a, d] = line.split('\t'); additions += Number(a) || 0; deletions += Number(d) || 0; } }
    const instructionNames = ['AGENTS.override.md', 'AGENTS.md', 'agents.md']; const detectedInstructionFiles: string[] = []; for (const name of instructionNames) try { await readFile(path.join(workspace.root, name)); detectedInstructionFiles.push(name); } catch { /* absent */ }
    return { workspaceName: workspace.name, isGitRepository: true, branch: status.branch, head: status.head, headShort: status.head?.slice(0, 12) ?? null, isDirty: changed.length > 0, stagedCount: status.files.filter(f => f.indexStatus !== '.' && f.kind !== 'untracked').length, unstagedCount: status.files.filter(f => f.worktreeStatus !== '.' && f.kind !== 'untracked').length, untrackedCount: status.files.filter(f => f.kind === 'untracked').length, conflictedCount: status.files.filter(f => f.kind === 'conflicted').length, changedFileCount: changed.length, additions, deletions, changedFiles: changed, detectedInstructionFiles, timestamp: new Date().toISOString(), warnings: status.files.some(f => !f.readable) ? ['部分路径受安全策略保护'] : [] };
  }) as never);
  server.registerTool('workspace_info', { title: '工作区信息', description: '返回项目技术栈、Git、远程仓库脱敏摘要与顶层结构；不读取文件正文。', inputSchema: {}, outputSchema, annotations: READ_ONLY_ANNOTATIONS }, wrap('workspace_info', async () => {
    const status = await git.status(); const names = await readdir(workspace.root); const remote = await remoteSummary(git); const languages = detectLanguages(names);
    const commandPolicy = access === 'full-access' ? 'unrestricted' : access === 'command-exec' ? 'allowlist' : 'none';
    return { workspaceName: workspace.name, repositoryName: remote.slug ?? workspace.name, branch: status.branch, head: status.head, remote, hasPackageJson: names.includes('package.json'), hasPomXml: names.includes('pom.xml'), hasGradle: names.includes('build.gradle') || names.includes('build.gradle.kts'), hasPyproject: names.includes('pyproject.toml'), hasGoMod: names.includes('go.mod'), languages, topLevel: names.filter(name => name !== '.git' && !isSensitive(name)).slice(0, 100), isDirty: status.files.length > 0, commands: commands?.summaries() ?? [], security: { access, readOnly: access === 'read-only', commandPolicy, sensitiveFilesBlocked: true, workspaceContained: true, networkDisabledForTools: access !== 'command-exec' && access !== 'full-access' } };
  }) as never);
  server.registerTool('workspace_instructions', { title: '项目指令', description: '按优先级读取根目录 AGENTS.override.md、AGENTS.md、agents.md，支持分页。', inputSchema: { cursor: z.string().optional(), maxBytes: z.number().int().min(1024).max(131072).default(65536) }, outputSchema, annotations: READ_ONLY_ANNOTATIONS }, wrap('workspace_instructions', async (input: { cursor?: string; maxBytes: number }) => {
    const found: Array<{ path: string; priority: number; content: string }> = []; for (const [priority, name] of ['AGENTS.override.md', 'AGENTS.md', 'agents.md'].entries()) try { const absolute = path.join(workspace.root, name); if ((await stat(absolute)).size > 1024 * 1024) continue; const content = await readFile(absolute, 'utf8'); found.push({ path: name, priority: 3 - priority, content }); } catch { /* absent */ }
    const combined = found.map(file => `===== ${file.path} (priority ${file.priority}) =====\n${file.content}`).join('\n'); const digest = requestDigest({ files: found.map(file => [file.path, file.content.length]) }); const offset = input.cursor ? workspace.cursors.verify(input.cursor, 'workspace_instructions', digest) : 0; const page = bytePage(combined, offset, boundedBytes(input.maxBytes));
    return { found: found.map(file => ({ path: file.path, priority: file.priority })), content: page.text, truncated: page.nextOffset !== undefined, ...(page.nextOffset === undefined ? {} : { nextCursor: workspace.cursors.sign('workspace_instructions', page.nextOffset, digest) }) };
  }) as never);
  server.registerTool('git_status', { title: 'Git 状态', description: '结构化返回 staged、unstaged、untracked、冲突、重命名和删除状态。', inputSchema: {}, outputSchema, annotations: READ_ONLY_ANNOTATIONS }, wrap('git_status', async () => {
    const status = await git.status(); const pick = (predicate: (f: typeof status.files[number]) => boolean) => status.files.filter(predicate);
    return { branch: status.branch, upstream: status.upstream, ahead: status.ahead, behind: status.behind, head: status.head, staged: pick(f => f.indexStatus !== '.' && f.kind !== 'untracked'), unstaged: pick(f => f.worktreeStatus !== '.' && f.kind !== 'untracked'), untracked: pick(f => f.kind === 'untracked'), conflicted: pick(f => f.kind === 'conflicted'), renamed: pick(f => f.kind === 'renamed'), deleted: pick(f => f.kind === 'deleted'), warnings: status.files.some(f => !f.readable) ? ['部分文件不可读'] : [] };
  }) as never);
  server.registerTool('git_changed_files', { title: '全部改动文件', description: '列出 staged、unstaged、untracked、冲突、重命名、复制和删除文件及安全状态。', inputSchema: {}, outputSchema, annotations: READ_ONLY_ANNOTATIONS }, wrap('git_changed_files', async () => ({ files: await git.changedFiles() })) as never);
  const diffInput = { scope: z.enum(['unstaged', 'staged', 'working_tree']), path: z.string().min(1).optional(), contextLines: z.number().int().min(0).max(20).default(3), maxBytes: z.number().int().min(1024).max(131072).default(65536), cursor: z.string().optional() };
  server.registerTool('git_diff', { title: 'Git 差异', description: '分页读取 unstaged、staged 或相对 HEAD 的安全 patch；不包含 untracked 正文和二进制正文。', inputSchema: diffInput, outputSchema, annotations: READ_ONLY_ANNOTATIONS }, wrap('git_diff', input => git.diff(input)) as never);
  server.registerTool('git_compare', { title: 'Git 分支/提交比较', description: '安全比较两个已存在的 commit/ref，支持 merge-base 三点比较或直接比较，不 fetch。', inputSchema: { base: z.string().min(1), head: z.string().min(1).default('HEAD'), mode: z.enum(['merge_base', 'direct']).default('merge_base'), path: z.string().min(1).optional(), contextLines: z.number().int().min(0).max(20).default(3), maxBytes: z.number().int().min(1024).max(131072).default(65536), cursor: z.string().optional() }, outputSchema, annotations: READ_ONLY_ANNOTATIONS }, wrap('git_compare', input => git.compare(input)) as never);
  server.registerTool('read_file', { title: '按行读取源码', description: '在 workspace 边界内按行分页读取 UTF-8 文本，拒绝敏感、忽略、大型、二进制及越界路径。', inputSchema: { path: z.string().min(1), startLine: z.number().int().min(1).default(1), endLine: z.number().int().min(1).optional(), maxLines: z.number().int().min(1).max(500).default(300), cursor: z.string().optional() }, outputSchema, annotations: READ_ONLY_ANNOTATIONS }, wrap('read_file', input => files.read(input)) as never);
  server.registerTool('search_workspace', { title: '搜索源码', description: '使用受限 ripgrep（不可用时 Node fallback）分页搜索源码，遵循 ignore 与敏感文件策略。', inputSchema: { query: z.string().min(1).max(500), isRegex: z.boolean().default(false), glob: z.union([z.string(), z.array(z.string()).max(20)]).optional(), maxResults: z.number().int().min(1).max(100).default(50), contextLines: z.number().int().min(0).max(3).default(0), caseSensitive: z.boolean().default(false), cursor: z.string().optional() }, outputSchema, annotations: READ_ONLY_ANNOTATIONS }, wrap('search_workspace', input => search.search(input)) as never);
  server.registerTool('list_directory', { title: '列出目录', description: '在 workspace 内分页列出目录、文件和符号链接及其安全状态，不跟随越界链接。', inputSchema: { path: z.string().default('.'), depth: z.number().int().min(1).max(3).default(1), maxEntries: z.number().int().min(1).max(500).default(200), cursor: z.string().optional() }, outputSchema, annotations: READ_ONLY_ANNOTATIONS }, wrap('list_directory', input => files.list(input)) as never);
  if (access !== 'read-only') {
    const patchSchema = z.discriminatedUnion('operation', [
      z.object({ operation: z.literal('create_file'), path: z.string().min(1).max(4096), diff: z.string().max(256 * 1024) }).strict(),
      z.object({ operation: z.literal('update_file'), path: z.string().min(1).max(4096), diff: z.string().max(256 * 1024), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
      z.object({ operation: z.literal('delete_file'), path: z.string().min(1).max(4096), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
    ]);
    const patches = new PatchService(workspace, coordinator);
    server.registerTool('apply_patch', { title: '应用受控补丁', description: '在 workspace 内创建、更新或删除单个 UTF-8 文件；更新和删除需要 read_file 返回的 SHA-256。', inputSchema: { operation: z.enum(['create_file', 'update_file', 'delete_file']), path: z.string().min(1), diff: z.string().optional(), expectedSha256: z.string().optional() }, outputSchema, annotations: WRITE_ANNOTATIONS }, wrap('apply_patch', async input => { const parsed = patchSchema.safeParse(input); if (!parsed.success) throw new AppError('INVALID_INPUT', 'apply_patch 输入无效'); return await patches.apply(parsed.data as PatchInput); }) as never);
  }
  if (access === 'command-exec') {
    if (!commands) throw new Error('command-exec 需要命令配置');
    server.registerTool('run_command', { title: '运行允许的命令', description: '仅运行用户配置中预先允许的 executable 与参数数组；不解析 shell 字符串。', inputSchema: { commandId: z.string().min(1).max(64), args: z.array(z.string().max(4096)).max(64).optional(), cwd: z.string().max(4096).default('.'), timeoutMs: z.number().int().min(100).max(600_000).optional() }, outputSchema, annotations: COMMAND_ANNOTATIONS }, wrap('run_command', (input, signal) => commands.run(input, signal)) as never);
  }
  if (access === 'full-access') {
    if (!fullAccessCommands) throw new Error('full-access 命令服务未初始化');
    const inputSchema = { executable: z.string().min(1).max(4096).refine(value => !value.includes('\0')), args: z.array(z.string().max(4096).refine(value => !value.includes('\0'))).max(64).optional(), cwd: z.string().max(4096).refine(value => !value.includes('\0')).default('.'), timeoutMs: z.number().int().min(100).max(600_000).optional(), maxOutputBytes: z.number().int().min(1024).max(1024 * 1024).optional() };
    const strictInputSchema = z.object(inputSchema).strict();
    server.registerTool('run_command', { title: '运行任意命令', description: '无需命令白名单，直接运行 executable 与参数数组；不解析 shell 字符串。', inputSchema: strictInputSchema, outputSchema, annotations: COMMAND_ANNOTATIONS }, wrap('run_command', async (input, signal) => { const parsed = strictInputSchema.safeParse(input); if (!parsed.success) throw new AppError('INVALID_INPUT', 'run_command 输入无效'); return await fullAccessCommands.run(parsed.data, signal); }) as never);
  }
}

function combineAbortSignals(primary: AbortSignal, secondary?: AbortSignal): { signal: AbortSignal; cleanup(): void } {
  if (!secondary) return { signal: primary, cleanup: () => undefined };
  const controller = new AbortController(); const abort = (): void => { if (!controller.signal.aborted) controller.abort(); };
  if (primary.aborted || secondary.aborted) abort(); else { primary.addEventListener('abort', abort, { once: true }); secondary.addEventListener('abort', abort, { once: true }); }
  return { signal: controller.signal, cleanup: () => { primary.removeEventListener('abort', abort); secondary.removeEventListener('abort', abort); } };
}

async function remoteSummary(git: GitService): Promise<{ configured: boolean; provider?: string; slug?: string }> { try { const value = (await git.runner.run(['remote', 'get-url', 'origin'])).stdout.toString().trim(); const clean = value.replace(/^[^@]+@/u, '').replace(/^https?:\/\/(?:[^@/]+@)?/u, '').replace(/\.git$/u, ''); const provider = clean.includes('github.com') ? 'github' : clean.includes('gitlab.com') ? 'gitlab' : 'other'; const pieces = clean.replace(':', '/').split('/'); return { configured: true, provider, slug: pieces.slice(-2).join('/') }; } catch { return { configured: false }; } }
function detectLanguages(names: string[]): string[] { const found: string[] = []; if (names.includes('package.json')) found.push('TypeScript/JavaScript'); if (names.includes('pom.xml') || names.some(n => n.startsWith('build.gradle'))) found.push('Java/Kotlin'); if (names.includes('pyproject.toml')) found.push('Python'); if (names.includes('go.mod')) found.push('Go'); return found; }
