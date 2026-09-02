import { createHash } from 'node:crypto';
import { DEFAULT_MAX_BYTES, HARD_MAX_BYTES } from '../shared/constants.js';

export function boundedBytes(value: number | undefined): number { return Math.min(value ?? DEFAULT_MAX_BYTES, HARD_MAX_BYTES); }
export function requestDigest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 22); }
export function bytePage(text: string, offset: number, limit: number): { text: string; nextOffset?: number } {
  const source = Buffer.from(text);
  if (offset >= source.length) return { text: '' };
  let end = Math.min(source.length, offset + limit);
  while (end > offset && end < source.length && (source[end] ?? 0) >= 0x80 && (source[end] ?? 0) < 0xc0) end--;
  const page = source.subarray(offset, end).toString('utf8');
  return end < source.length ? { text: page, nextOffset: end } : { text: page };
}
