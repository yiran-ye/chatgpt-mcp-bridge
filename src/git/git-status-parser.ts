export interface StatusFile {
  path: string; oldPath?: string; indexStatus: string; worktreeStatus: string;
  kind: 'ordinary' | 'renamed' | 'copied' | 'untracked' | 'conflicted' | 'deleted';
}
export interface ParsedStatus { branch: string | null; upstream: string | null; ahead: number; behind: number; head: string | null; files: StatusFile[] }

export function parseStatus(buffer: Buffer): ParsedStatus {
  const records = buffer.toString('utf8').split('\0');
  const result: ParsedStatus = { branch: null, upstream: null, ahead: 0, behind: 0, head: null, files: [] };
  for (let index = 0; index < records.length; index++) {
    const record = records[index] ?? '';
    if (record.startsWith('# branch.oid ')) result.head = record.slice(13) === '(initial)' ? null : record.slice(13);
    else if (record.startsWith('# branch.head ')) result.branch = record.slice(14) === '(detached)' ? null : record.slice(14);
    else if (record.startsWith('# branch.upstream ')) result.upstream = record.slice(18);
    else if (record.startsWith('# branch.ab ')) { const match = /\+(\d+) -(\d+)/u.exec(record); result.ahead = Number(match?.[1] ?? 0); result.behind = Number(match?.[2] ?? 0); }
    else if (record.startsWith('? ')) result.files.push({ path: record.slice(2), indexStatus: '?', worktreeStatus: '?', kind: 'untracked' });
    else if (record.startsWith('u ')) { const fields = record.split(' '); result.files.push({ path: fields.slice(10).join(' '), indexStatus: 'U', worktreeStatus: 'U', kind: 'conflicted' }); }
    else if (record.startsWith('1 ')) {
      const fields = record.split(' '); const xy = fields[1] ?? '..'; const filePath = fields.slice(8).join(' ');
      result.files.push({ path: filePath, indexStatus: xy[0] ?? '.', worktreeStatus: xy[1] ?? '.', kind: xy.includes('D') ? 'deleted' : 'ordinary' });
    } else if (record.startsWith('2 ')) {
      const fields = record.split(' '); const xy = fields[1] ?? '..'; const score = fields[8] ?? 'R'; const filePath = fields.slice(9).join(' '); const oldPath = records[++index] ?? '';
      result.files.push({ path: filePath, oldPath, indexStatus: xy[0] ?? '.', worktreeStatus: xy[1] ?? '.', kind: score.startsWith('C') ? 'copied' : 'renamed' });
    }
  }
  return result;
}
