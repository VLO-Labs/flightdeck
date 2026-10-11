// A line diff for reviewing a proposed document edit: longest common subsequence, then the changes
// with a few unchanged lines around each. Documents are small (a PRD is hundreds of lines), so the
// quadratic table is fine; past a size it falls back to "everything changed" rather than stall.
export type DiffLine = { op: 'same' | 'add' | 'del'; text: string; a?: number; b?: number }; // a/b: 1-based line numbers
export type DiffHunk = { lines: DiffLine[] } | { skipped: number };

const MAX_CELLS = 4_000_000;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  // Common head and tail don't need the table.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA), midB = b.slice(start, endB);
  const out: DiffLine[] = a.slice(0, start).map((text, i) => ({ op: 'same', text, a: i + 1, b: i + 1 }));

  if (midA.length * midB.length > MAX_CELLS) {
    midA.forEach((text, i) => out.push({ op: 'del', text, a: start + i + 1 }));
    midB.forEach((text, i) => out.push({ op: 'add', text, b: start + i + 1 }));
  } else {
    const n = midA.length, m = midB.length;
    const t: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      t[i]![j] = midA[i] === midB[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
    }
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) { out.push({ op: 'same', text: midA[i]!, a: start + i + 1, b: start + j + 1 }); i++; j++; }
      // Removed lines before the lines that replace them.
      else if (i < n && (j === m || t[i + 1]![j]! >= t[i]![j + 1]!)) { out.push({ op: 'del', text: midA[i]!, a: start + i + 1 }); i++; }
      else { out.push({ op: 'add', text: midB[j]!, b: start + j + 1 }); j++; }
    }
  }
  const tailA = endA, tailB = endB;
  a.slice(endA).forEach((text, k) => out.push({ op: 'same', text, a: tailA + k + 1, b: tailB + k + 1 }));
  return out;
}

// The changes with `context` unchanged lines on each side; longer unchanged runs are folded.
export function hunks(lines: DiffLine[], context = 3): DiffHunk[] {
  const keep = lines.map(() => false);
  lines.forEach((l, i) => {
    if (l.op === 'same') return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: DiffHunk[] = [];
  let run: DiffLine[] = [], skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) { out.push({ skipped }); skipped = 0; }
      run.push(l);
    } else {
      if (run.length) { out.push({ lines: run }); run = []; }
      skipped++;
    }
  });
  if (run.length) out.push({ lines: run });
  if (skipped) out.push({ skipped });
  return out;
}

// Apply Edit-tool-style replacements: each `old_string` must occur exactly once in the text as it is
// by then. Returns the new text, or why it can't.
export function applyEdits(text: string, edits: { old_string: string; new_string: string }[]): { ok: true; text: string } | { ok: false; error: string } {
  let out = text;
  for (const [i, e] of edits.entries()) {
    if (e.old_string === '') return { ok: false, error: `edit ${i + 1}: old_string is empty (to write a whole document, send content instead)` };
    const at = out.indexOf(e.old_string);
    if (at === -1) return { ok: false, error: `edit ${i + 1}: old_string not found in the document (read it again; it must match exactly, including whitespace)` };
    if (out.indexOf(e.old_string, at + 1) !== -1) return { ok: false, error: `edit ${i + 1}: old_string occurs more than once; include more surrounding text so it is unique` };
    out = out.slice(0, at) + e.new_string + out.slice(at + e.old_string.length);
  }
  return { ok: true, text: out };
}
