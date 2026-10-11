import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReadOnlyShell } from './shell.ts';

test('plain inspection is read-only, including compound lines of it', () => {
  for (const c of ['git status', 'git diff --stat', 'git log --oneline -5', 'ls -la src', 'cat a.ts | head -20',
    'grep -rn foo src', 'find . -name "*.ts"', 'git status && git diff', 'wc -l src/*.ts', 'git branch -a']) {
    assert.equal(isReadOnlyShell(c), true, c);
  }
});

test('anything that can change files or run something else is not', () => {
  for (const c of [
    'npm test', 'git commit -m x', 'git branch -D old', 'git log --output=notes.txt', 'rm a.ts',
    'git status && rm a.ts', 'cat a > b', 'echo hi >> notes.md', 'ls $(rm -rf x)', 'ls `touch x`',
    'find . -name x -delete', 'find . -exec rm {} ;', 'env rm -rf x', 'tree -o out.txt', 'rg --pre ./run.sh x',
    'sed -i s/a/b/ f', '',
  ]) {
    assert.equal(isReadOnlyShell(c), false, c);
  }
});
