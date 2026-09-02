export function originAllowed(origin: string | undefined, host: string, publicBind: boolean): boolean {
  if (!origin) return !publicBind;
  let parsed: URL; try { parsed = new URL(origin); } catch { return false; }
  if (publicBind) return parsed.protocol === 'https:';
  return ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname) && ['http:', 'https:'].includes(parsed.protocol) && (host === '127.0.0.1' || host === 'localhost' || host === '::1');
}
