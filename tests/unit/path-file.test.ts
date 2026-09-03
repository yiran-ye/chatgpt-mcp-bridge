import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, type GitFixture } from '../helpers/git-fixture.js';
import { WorkspaceContext } from '../../src/workspace/workspace-context.js';
import { FileService } from '../../src/workspace/file-service.js';

describe('PathPolicy 与 FileService', () => {
  let fixture: GitFixture; let service: FileService;
  beforeAll(async () => { fixture = await createFixture(); await mkdir(path.join(fixture.root, '.chatgpt-mcp-bridge')); await writeFile(path.join(fixture.root, '.chatgpt-mcp-bridge', 'config.json'), '{}'); service = new FileService(await WorkspaceContext.create(fixture.root)); });
  afterAll(async () => fixture.cleanup());
  it('按行读取并返回行号', async () => { const result = await service.read({ path: 'tracked.ts', startLine: 1, maxLines: 1 }); expect(result['content']).toContain('1: export'); expect(result['startLine']).toBe(1); });
  it('分页读取且游标可续读', async () => { const first = await service.read({ path: 'tracked.ts', maxLines: 1 }); expect(first['truncated']).toBe(true); const second = await service.read({ path: 'tracked.ts', maxLines: 1, cursor: String(first['nextCursor']) }); expect(second['startLine']).toBe(2); });
  it('篡改游标会拒绝', async () => { const first = await service.read({ path: 'tracked.ts', maxLines: 1 }); await expect(service.read({ path: 'tracked.ts', maxLines: 1, cursor: `${String(first['nextCursor'])}x` })).rejects.toMatchObject({ code: 'INVALID_CURSOR' }); });
  it('游标不能切换文件', async () => { const first = await service.read({ path: 'tracked.ts', maxLines: 1 }); await expect(service.read({ path: 'SecretService.java', maxLines: 1, cursor: String(first['nextCursor']) })).rejects.toMatchObject({ code: 'INVALID_CURSOR' }); });
  it('拒绝大文件', async () => expect(service.read({ path: 'large.txt' })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' }));
  it('拒绝二进制文件', async () => expect(service.read({ path: 'binary.bin' })).rejects.toMatchObject({ code: 'BINARY_FILE' }));
  it.each(['.env', 'private.pem', 'application-prod.yml'])('拒绝敏感文件 %s', async path => expect(service.read({ path })).rejects.toMatchObject({ code: 'SENSITIVE_FILE' }));
  it('允许名称含 Secret 的普通源码', async () => expect((await service.read({ path: 'SecretService.java' }))['content']).toContain('SecretService'));
  it('workspace ignore 生效', async () => expect(service.read({ path: 'ignored.txt' })).rejects.toMatchObject({ code: 'PATH_BLOCKED' }));
  it('MCP 数据面不能读取项目级 Bridge 配置', async () => expect(service.read({ path: '.chatgpt-mcp-bridge/config.json' })).rejects.toMatchObject({ code: 'PATH_BLOCKED' }));
  it.each(['../outside.txt', '../../.ssh/id_rsa', '/etc/passwd', '%2e%2e/outside.txt'])('拒绝 traversal %s', async path => expect(service.read({ path })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' }));
  it('拒绝越界 symlink', async () => expect(service.read({ path: 'escape-link' })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' }));
  it('目录列表不暴露绝对路径并标记阻止项', async () => { const result = await service.list({ depth: 1 }); expect(JSON.stringify(result)).not.toContain(fixture.root); expect(result['entries']).toEqual(expect.arrayContaining([expect.objectContaining({ path: '.env', readable: false })])); });
});
