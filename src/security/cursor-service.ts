import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '../shared/errors.js';

interface CursorPayload { type: string; offset: number; digest: string }

export class CursorService {
  readonly #secret = randomBytes(32);
  sign(type: string, offset: number, digest: string): string {
    const body = Buffer.from(JSON.stringify({ type, offset, digest })).toString('base64url');
    const signature = createHmac('sha256', this.#secret).update(body).digest('base64url');
    return `${body}.${signature}`;
  }
  verify(cursor: string, type: string, digest: string): number {
    const [body, supplied] = cursor.split('.');
    if (body === undefined || supplied === undefined) throw new AppError('INVALID_CURSOR', '游标格式无效');
    const expected = createHmac('sha256', this.#secret).update(body).digest();
    let actual: Buffer;
    try { actual = Buffer.from(supplied, 'base64url'); } catch { throw new AppError('INVALID_CURSOR', '游标签名无效'); }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new AppError('INVALID_CURSOR', '游标已被修改');
    let parsed: CursorPayload;
    try { parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CursorPayload; }
    catch { throw new AppError('INVALID_CURSOR', '游标内容无效'); }
    if (parsed.type !== type || parsed.digest !== digest || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) throw new AppError('INVALID_CURSOR', '游标与当前请求不匹配');
    return parsed.offset;
  }
}
