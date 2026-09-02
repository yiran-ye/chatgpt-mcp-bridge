import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { AppError } from '../shared/errors.js';
import { CursorService } from '../security/cursor-service.js';
import { IgnorePolicy } from './ignore-policy.js';
import { PathPolicy } from './path-policy.js';

export class WorkspaceContext {
  private constructor(readonly root: string, readonly name: string, readonly ignore: IgnorePolicy, readonly paths: PathPolicy, readonly cursors: CursorService) {}
  static async create(input: string): Promise<WorkspaceContext> {
    let root: string;
    try { if (!(await stat(input)).isDirectory()) throw new Error('not directory'); root = await realpath(path.resolve(input)); }
    catch { throw new AppError('WORKSPACE_NOT_FOUND', 'workspace 不存在或不是目录'); }
    const ignores = await IgnorePolicy.create(root);
    return new WorkspaceContext(root, path.basename(root), ignores, new PathPolicy(root, ignores), new CursorService());
  }
}
