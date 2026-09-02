import { timingSafeEqual } from 'node:crypto';
export function bearerAuthorized(header: string | undefined, token: string | undefined): boolean {
  if (!token) return true; if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7)); const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
