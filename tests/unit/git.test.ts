import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConflictFixture, createFixture, type GitFixture } from '../helpers/git-fixture.js';
import { WorkspaceContext } from '../../src/workspace/workspace-context.js';
import { GitService } from '../../src/git/git-service.js';

describe('GitService', () => {
  let fixture: GitFixture; let git: GitService;
  beforeAll(async () => { fixture = await createFixture(); git = new GitService(await WorkspaceContext.create(fixture.root)); }); afterAll(async () => fixture.cleanup());
  it('区分 staged、unstaged、untracked 和 rename/delete', async () => { const status = await git.status(); expect(status.files.some(f => f.path === 'staged.ts' && f.indexStatus === 'A')).toBe(true); expect(status.files.some(f => f.path === 'tracked.ts' && f.worktreeStatus === 'M')).toBe(true); expect(status.files.some(f => f.path === 'untracked.ts' && f.kind === 'untracked')).toBe(true); expect(status.files.some(f => f.kind === 'renamed')).toBe(true); expect(status.files.some(f => f.kind === 'deleted')).toBe(true); });
  it('changed files 包含 untracked', async () => expect(await git.changedFiles()).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'untracked.ts', category: 'untracked' })])));
  it.each([['unstaged', 'tracked.ts'], ['staged', 'staged.ts'], ['working_tree', 'staged.ts']] as const)('%s diff 正确', async (scope, expected) => expect((await git.diff({ scope }))['patch']).toContain(expected));
  it('working_tree 摘要提示 untracked', async () => expect((await git.diff({ scope: 'working_tree' }))['untracked']).toContain('untracked.ts'));
  it('比较 main...HEAD', async () => { const result = await git.compare({ base: 'main', head: 'HEAD' }); expect(result['patch']).toContain('feature.ts'); expect(result['mergeBase']).toBeTruthy(); });
  it.each(['--help', 'bad ref', 'HEAD^{}'])('拒绝无效 ref %s', async ref => expect(git.resolveRef(ref)).rejects.toMatchObject({ code: 'INVALID_GIT_REF' }));
  it('拒绝以 - 开头的 path', async () => expect(git.diff({ scope: 'unstaged', path: '--output=x' })).rejects.toMatchObject({ code: 'INVALID_INPUT' }));
  it('diff 游标防篡改', async () => { const result = await git.diff({ scope: 'working_tree', maxBytes: 1024 }); if (result['nextCursor']) await expect(git.diff({ scope: 'working_tree', maxBytes: 1024, cursor: `${String(result['nextCursor'])}x` })).rejects.toMatchObject({ code: 'INVALID_CURSOR' }); });
  it('结果不含 workspace 绝对路径', async () => expect(JSON.stringify(await git.changedFiles())).not.toContain(fixture.root));
});

it('解析 conflicted 状态', async () => { const fixture = await createConflictFixture(); try { const git = new GitService(await WorkspaceContext.create(fixture.root)); expect((await git.status()).files.some(f => f.kind === 'conflicted')).toBe(true); } finally { await fixture.cleanup(); } });
