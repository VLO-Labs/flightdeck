import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReadOnlyShell } from './shell.ts';

test('plain inspection is read-only, including compound lines of it', () => {
  for (const c of ['git status', 'git diff --stat', 'git log --oneline -5', 'ls -la src', 'cat a.ts | head -20',
    'grep -rn foo src', 'find . -name "*.ts"', 'git status && git diff', 'wc -l src/*.ts', 'git branch -a',
    'cd app && ls', 'ps aux | grep vite', 'lsof -ti tcp:8000', 'curl -s http://localhost:8000/admin/login | grep title',
    'curl -sI http://x/', 'php -v', 'composer --version', 'node --version', 'git config --get user.name', 'git reflog', 'git tag -l', 'sort -u a.txt']) {
    assert.equal(isReadOnlyShell(c), true, c);
  }
});

test('anything that can change files or run something else is not', () => {
  for (const c of [
    'npm test', 'git commit -m x', 'git branch -D old', 'git log --output=notes.txt', 'rm a.ts',
    'git status && rm a.ts', 'cat a > b', 'echo hi >> notes.md', 'ls $(rm -rf x)', 'ls `touch x`',
    'find . -name x -delete', 'find . -exec rm {} ;', 'env rm -rf x', 'tree -o out.txt', 'rg --pre ./run.sh x',
    'sed -i s/a/b/ f', '',
    "sed -i '' 's/a/b/' .env", 'lsof -ti tcp:8000 | xargs kill', 'kill 123', "pkill -f 'artisan dev'",
    'nohup composer dev > log 2>&1 &', 'composer dev', 'php artisan config:clear', 'curl -o x http://a',
    'curl -sO http://a/f', 'curl -X POST http://a', 'curl -d a=1 http://a', 'curl --data-raw x http://a',
    'sort -o out a.txt', 'git config user.name x', 'git reflog expire --all', 'git tag v1', 'npm install', 'npm --version && rm -rf x',
  ]) {
    assert.equal(isReadOnlyShell(c), false, c);
  }
});
