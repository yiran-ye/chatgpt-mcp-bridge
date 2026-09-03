import { createHash, randomBytes } from 'node:crypto';
import { chmod, link, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../shared/errors.js';
import { MAX_FILE_BYTES } from '../shared/constants.js';
import type { MutationCoordinator } from '../security/mutation-coordinator.js';
import type { WorkspaceContext } from './workspace-context.js';

export type PatchInput =
  | { operation: 'create_file'; path: string; diff: string }
  | { operation: 'update_file'; path: string; diff: string; expectedSha256: string }
  | { operation: 'delete_file'; path: string; expectedSha256: string };

const MAX_PATCH_BYTES = 256 * 1024;

export class PatchService {
  constructor(private readonly workspace: WorkspaceContext, private readonly coordinator: MutationCoordinator) {}

  async apply(input: PatchInput): Promise<Record<string, unknown>> {
    return await this.coordinator.run(async () => {
      if (input.operation === 'create_file') return await this.#create(input);
      const resolved = await this.workspace.paths.resolve(input.path);
      const before = await readSafeText(resolved.absolute);
      const beforeSha256 = digest(before);
      if (beforeSha256 !== input.expectedSha256) throw new AppError('PATCH_CONFLICT', '文件内容已变化，请重新读取后再修改');
      if (input.operation === 'delete_file') {
        if (digest(await readSafeText(resolved.absolute)) !== beforeSha256) throw new AppError('PATCH_CONFLICT', '文件在删除前发生变化');
        await rm(resolved.absolute);
        return { operation: input.operation, path: resolved.relative, beforeSha256, afterSha256: null, bytes: 0 };
      }
      validatePatchSize(input.diff);
      const next = applyUnifiedDiff(before, input.diff);
      if (Buffer.byteLength(next) > MAX_FILE_BYTES) throw new AppError('FILE_TOO_LARGE', `结果文件超过 ${MAX_FILE_BYTES} 字节限制`);
      await atomicWrite(resolved.absolute, next, Number(resolved.stat.mode));
      return { operation: input.operation, path: resolved.relative, beforeSha256, afterSha256: digest(next), bytes: Buffer.byteLength(next) };
    });
  }

  async #create(input: Extract<PatchInput, { operation: 'create_file' }>): Promise<Record<string, unknown>> {
    validatePatchSize(input.diff);
    const resolved = await this.workspace.paths.resolveForCreate(input.path);
    const next = applyUnifiedDiff('', input.diff);
    if (Buffer.byteLength(next) > MAX_FILE_BYTES) throw new AppError('FILE_TOO_LARGE', `结果文件超过 ${MAX_FILE_BYTES} 字节限制`);
    await atomicCreate(resolved.absolute, next, 0o644);
    return { operation: input.operation, path: resolved.relative, beforeSha256: null, afterSha256: digest(next), bytes: Buffer.byteLength(next) };
  }
}

export function sha256(content: string | Buffer): string { return digest(content); }

function digest(content: string | Buffer): string { return createHash('sha256').update(content).digest('hex'); }
function validatePatchSize(diff: string): void { if (Buffer.byteLength(diff) > MAX_PATCH_BYTES) throw new AppError('INVALID_PATCH', 'patch 超过 256 KiB'); }
async function readSafeText(absolute: string): Promise<string> {
  const buffer = await readFile(absolute);
  if (buffer.length > MAX_FILE_BYTES) throw new AppError('FILE_TOO_LARGE', `文件超过 ${MAX_FILE_BYTES} 字节限制`);
  if (buffer.includes(0)) throw new AppError('BINARY_FILE', '拒绝修改二进制文件');
  const content = buffer.toString('utf8');
  if (content.includes('\uFFFD')) throw new AppError('BINARY_FILE', '文件不是可安全识别的 UTF-8 文本');
  return content;
}
async function atomicWrite(target: string, content: string, mode: number): Promise<void> {
  const temporary = path.join(path.dirname(target), `.chatgpt-mcp-bridge-${randomBytes(8).toString('hex')}.tmp`);
  try { await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: mode & 0o777 }); await chmod(temporary, mode & 0o777); await rename(temporary, target); }
  catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
}
async function atomicCreate(target: string, content: string, mode: number): Promise<void> {
  const temporary = path.join(path.dirname(target), `.chatgpt-mcp-bridge-${randomBytes(8).toString('hex')}.tmp`);
  try { await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode }); await link(temporary, target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError('PATCH_CONFLICT', '创建目标已存在'); throw error; }
  finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

function applyUnifiedDiff(original: string, diff: string): string {
  const patchLines = diff.replaceAll('\r\n', '\n').split('\n');
  if (patchLines.at(-1) === '') patchLines.pop();
  if (!patchLines[0]?.startsWith('--- ') || !patchLines[1]?.startsWith('+++ ')) throw new AppError('INVALID_PATCH', 'patch 缺少统一 diff 文件头');
  const hadFinalNewline = original.endsWith('\n');
  const source = original === '' ? [] : original.replaceAll('\r\n', '\n').replace(/\n$/u, '').split('\n');
  const output: string[] = []; let sourceIndex = 0; let index = 2;
  while (index < patchLines.length) {
    const header = patchLines[index++];
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u.exec(header ?? '');
    if (!match) throw new AppError('INVALID_PATCH', 'patch hunk 头无效');
    const oldStart = Number(match[1]); const oldCount = Number(match[2] ?? '1'); const newCount = Number(match[4] ?? '1');
    const expectedIndex = oldCount === 0 ? oldStart : oldStart - 1;
    if (expectedIndex < sourceIndex || expectedIndex > source.length) throw new AppError('INVALID_PATCH', 'patch hunk 位置无效');
    output.push(...source.slice(sourceIndex, expectedIndex)); sourceIndex = expectedIndex;
    let consumed = 0; let produced = 0;
    while (index < patchLines.length && !patchLines[index]?.startsWith('@@ ')) {
      const line = patchLines[index++];
      if (line === '\\ No newline at end of file') continue;
      const prefix = line?.[0]; const value = line?.slice(1) ?? '';
      if (prefix === ' ') { if (source[sourceIndex] !== value) throw new AppError('PATCH_CONFLICT', 'patch 上下文与当前文件不一致'); output.push(value); sourceIndex++; consumed++; produced++; }
      else if (prefix === '-') { if (source[sourceIndex] !== value) throw new AppError('PATCH_CONFLICT', 'patch 删除内容与当前文件不一致'); sourceIndex++; consumed++; }
      else if (prefix === '+') { output.push(value); produced++; }
      else throw new AppError('INVALID_PATCH', 'patch 行前缀无效');
    }
    if (consumed !== oldCount || produced !== newCount) throw new AppError('INVALID_PATCH', 'patch hunk 行数不匹配');
  }
  output.push(...source.slice(sourceIndex));
  const result = output.join('\n');
  return result === '' ? '' : `${result}${hadFinalNewline || !diff.includes('\\ No newline at end of file') ? '\n' : ''}`;
}
