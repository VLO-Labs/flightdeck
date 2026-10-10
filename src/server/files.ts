// Read-only file viewing inside a project. Never leaves the project folder, never shows .git.
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { FileResponse } from '../shared/contracts.ts';
import { repoFiles } from './maps.ts';

const MAX = 512 * 1024;

export function viewFile(projectPath: string, rel: string): FileResponse | { error: string } {
  const root = realpathSync(projectPath);
  let abs: string;
  try {
    abs = realpathSync(join(root, rel));
  } catch {
    return { error: 'not found' };
  }
  const inside = relative(root, abs);
  if (inside.startsWith('..') || inside.split(sep).includes('.git')) return { error: 'outside the project' };

  const st = statSync(abs);
  if (st.isDirectory()) {
    const prefix = inside === '' ? '' : inside + '/';
    const entries = new Set<string>();
    for (const f of repoFiles(root)) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      const cut = rest.indexOf('/');
      entries.add(cut === -1 ? rest : rest.slice(0, cut + 1));
    }
    return { kind: 'dir', path: prefix, entries: [...entries].sort((a, b) => Number(b.endsWith('/')) - Number(a.endsWith('/')) || a.localeCompare(b)) };
  }

  const fd = openSync(abs, 'r');
  const buf = Buffer.alloc(Math.min(st.size, MAX));
  readSync(fd, buf, 0, buf.length, 0);
  closeSync(fd);
  if (buf.includes(0)) return { kind: 'binary', path: inside, size: st.size };
  return { kind: 'file', path: inside, content: buf.toString('utf8'), truncated: st.size > MAX };
}
