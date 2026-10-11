import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits, diffLines, hunks } from './diff.ts';
import { findRef } from './requirements.ts';

test('a line diff keeps what is shared and marks what changed', () => {
  const d = diffLines('a\nb\nc\nd', 'a\nB\nc\nd\ne');
  assert.deepEqual(d.map(l => `${l.op[0]}${l.text}`), ['sa', 'db', 'aB', 'sc', 'sd', 'ae']);
  assert.deepEqual(diffLines('', 'x').map(l => l.op), ['add']);
  assert.deepEqual(diffLines('same', 'same').map(l => l.op), ['same']);
});

test('hunks fold long unchanged runs', () => {
  const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
  const h = hunks(diffLines(before, before.replace('l10', 'X')), 2);
  assert.deepEqual(h.map(x => ('skipped' in x ? `skip ${x.skipped}` : x.lines.map(l => l.op[0]).join(''))), ['skip 8', 'ssdass', 'skip 7']);
});

test('edits apply only when each old_string is found exactly once', () => {
  assert.deepEqual(applyEdits('a b c', [{ old_string: 'b', new_string: 'B' }, { old_string: 'c', new_string: 'C' }]), { ok: true, text: 'a B C' });
  assert.match((applyEdits('a a', [{ old_string: 'a', new_string: 'b' }]) as { error: string }).error, /more than once/);
  assert.match((applyEdits('a', [{ old_string: 'z', new_string: 'b' }]) as { error: string }).error, /not found/);
  assert.match((applyEdits('a', [{ old_string: '', new_string: 'b' }]) as { error: string }).error, /empty/);
});

test('a reference names a requirement by id or a section by heading', () => {
  const md = '# P\n\n## Scope\nIn: shop.\n### In scope\nCarts.\n## Business rules\n### BR-001 · Pay first\nAlways.\n';
  assert.deepEqual(findRef(md, 'BR-001'), { label: 'BR-001 Pay first', text: '### BR-001 · Pay first\nAlways.', retired: false });
  assert.deepEqual(findRef(md, '§Scope'), { label: '§ Scope', text: '## Scope\nIn: shop.\n### In scope\nCarts.' });
  assert.equal(findRef(md, 'BR-002'), null);
  assert.equal(findRef(md, '§Nope'), null);
});
