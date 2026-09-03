import { readFile } from 'node:fs/promises';

export async function releaseNotes(version: string): Promise<string> {
  const changelog = await readFile('CHANGELOG.md', 'utf8');
  const lines = changelog.split(/\r?\n/u); const heading = new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\](?: - \\d{4}-\\d{2}-\\d{2})?$`, 'u');
  const start = lines.findIndex(line => heading.test(line)); const end = start < 0 ? -1 : lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const notes = start < 0 ? undefined : lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
  if (!notes) throw new Error(`CHANGELOG.md 缺少 ${version} 的非空版本说明`);
  return notes;
}
