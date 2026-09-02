import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, type GitFixture } from '../helpers/git-fixture.js';
import { WorkspaceContext } from '../../src/workspace/workspace-context.js';
import { matchesGlobs, SearchService } from '../../src/search/search-service.js';
import { CursorService } from '../../src/security/cursor-service.js';
import { bearerAuthorized } from '../../src/transports/auth-policy.js';
import { originAllowed } from '../../src/transports/origin-policy.js';

describe('搜索与安全策略', () => {
  let fixture: GitFixture; let search: SearchService;
  beforeAll(async () => { fixture = await createFixture(); search = new SearchService(await WorkspaceContext.create(fixture.root)); }); afterAll(async () => fixture.cleanup());
  it('搜索源码', async () => expect((await search.search({ query: 'needle' }))['results']).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'untracked.ts' })])));
  it('不返回敏感和 ignored 文件', async () => { const text = JSON.stringify(await search.search({ query: 'hidden' })); expect(text).not.toContain('.env'); expect(text).not.toContain('ignored.txt'); });
  it('query 以 - 开头不形成参数注入', async () => { const result = await search.search({ query: '--version' }); expect(result['results']).toEqual([]); });
  it('shell 元字符不执行', async () => { const result = await search.search({ query: '$(touch injected)' }); expect(result['results']).toEqual([]); });
  it('Node fallback 的 glob 匹配安全可用', () => { expect(matchesGlobs('src/a.ts', '**/*.ts')).toBe(true); expect(matchesGlobs('src/a.js', '**/*.ts')).toBe(false); });
  it('CursorService 拒绝篡改和类型切换', () => { const cursor = new CursorService(); const signed = cursor.sign('a', 1, 'd'); expect(() => cursor.verify(`${signed}x`, 'a', 'd')).toThrow(); expect(() => cursor.verify(signed, 'b', 'd')).toThrow(); });
  it('Bearer 使用精确 token', () => { expect(bearerAuthorized('Bearer abcdefghijklmnop', 'abcdefghijklmnop')).toBe(true); expect(bearerAuthorized('Bearer wrong', 'abcdefghijklmnop')).toBe(false); });
  it('Origin 策略区分 loopback/public', () => { expect(originAllowed(undefined, '127.0.0.1', false)).toBe(true); expect(originAllowed('https://evil.example', '127.0.0.1', false)).toBe(false); expect(originAllowed(undefined, '0.0.0.0', true)).toBe(false); expect(originAllowed('https://client.example', '0.0.0.0', true)).toBe(true); });
});
