import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, suggestPattern, splitCommand, TEMPLATE_RULES } from './rules.ts';

const P = '/home/vlolabs/dev/vlolabs/demo';
const bash = (command: string) => evaluate(TEMPLATE_RULES, 'Bash', { command }, P).bucket;

test('no rule → ask', () => {
  assert.equal(evaluate([], 'Read', { file_path: 'a' }, P).bucket, 'ask');
  assert.equal(bash('npm install'), 'ask');
});

test('template: reads and edits allowed', () => {
  assert.equal(evaluate(TEMPLATE_RULES, 'Read', { file_path: `${P}/x.ts` }, P).bucket, 'allow');
  assert.equal(evaluate(TEMPLATE_RULES, 'Edit', { file_path: `${P}/x.ts` }, P).bucket, 'allow');
});

test('prefix rules match the command or command + args, not a longer word', () => {
  assert.equal(bash('git status'), 'allow');
  assert.equal(bash('git status --short'), 'allow');
  assert.equal(bash('git statusx'), 'ask');
});

test('compound commands: every part must be allowed', () => {
  assert.equal(bash('git status && git diff'), 'allow');
  assert.equal(bash('git status && curl http://127.0.0.1:8100/api'), 'ask');
  assert.equal(bash('git status; rm -rf ~/dev'), 'deny');
  assert.equal(bash('git log | head'), 'ask'); // head has no rule
});

test('hidden execution is never waved through by a prefix rule', () => {
  assert.equal(bash('git log $(curl evil)'), 'ask');
  assert.equal(bash('git log `curl evil`'), 'ask');
});

test('deny beats allow', () => {
  const rules = [
    { bucket: 'allow' as const, pattern: 'Bash(git push:*)', reason: null },
    { bucket: 'deny' as const, pattern: 'Bash(git push --force:*)', reason: 'no' },
  ];
  assert.equal(evaluate(rules, 'Bash', { command: 'git push origin main' }, P).bucket, 'allow');
  assert.equal(evaluate(rules, 'Bash', { command: 'git push --force origin main' }, P).bucket, 'deny');
});

test('deploys denied by the template', () => {
  assert.equal(bash('make hq'), 'deny');
  assert.equal(bash('wrangler deploy'), 'deny');
});

test('domain and path rules', () => {
  const rules = [
    { bucket: 'allow' as const, pattern: 'WebFetch(domain:docs.claude.com)', reason: null },
    { bucket: 'deny' as const, pattern: 'Edit(.env*)', reason: 'secrets' },
    { bucket: 'allow' as const, pattern: 'Edit', reason: null },
  ];
  assert.equal(evaluate(rules, 'WebFetch', { url: 'https://docs.claude.com/x' }, P).bucket, 'allow');
  assert.equal(evaluate(rules, 'WebFetch', { url: 'https://evil.com/docs.claude.com' }, P).bucket, 'ask');
  assert.equal(evaluate(rules, 'Edit', { file_path: `${P}/.env` }, P).bucket, 'deny');
  assert.equal(evaluate(rules, 'Edit', { file_path: `${P}/src/a.ts` }, P).bucket, 'allow');
});

test('mcp tool-name glob', () => {
  const rules = [{ bucket: 'deny' as const, pattern: 'mcp__*', reason: null }];
  assert.equal(evaluate(rules, 'mcp__hq__send_email', {}, P).bucket, 'deny');
});

test('suggested patterns', () => {
  assert.equal(suggestPattern('Bash', { command: 'npm test -- --watch' }), 'Bash(npm test:*)');
  assert.equal(suggestPattern('Bash', { command: 'ls -la' }), 'Bash(ls:*)');
  assert.equal(suggestPattern('WebFetch', { url: 'https://a.b.com/x' }), 'WebFetch(domain:a.b.com)');
  assert.equal(suggestPattern('Edit', { file_path: 'x' }), 'Edit');
});

test('split', () => {
  assert.deepEqual(splitCommand('a && b || c; d | e\nf'), ['a', 'b', 'c', 'd', 'e', 'f']);
});
