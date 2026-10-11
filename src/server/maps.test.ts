import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MapNode } from '../shared/contracts.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedSince, generatorDecision, repoDirs, repoFiles, staleNodeIds, validateMap } from './maps.ts';

const node = (id: string, parent: string | null, files: string[] = []): MapNode =>
  ({ id, parent, label: id, kind: 'module', summary: '', files, fields: [] });
const REPO = ['src/api/orders.ts', 'src/api/users.ts', 'src/worker/send.ts', 'README.md'];

test('valid map passes; directories get their slash; missing files are dropped with a warning', () => {
  const r = validateMap({
    nodes: [node('api', null, ['src/api', './README.md', 'src/nope.ts']), node('orders', 'api', ['src/api/orders.ts'])],
    edges: [],
  }, REPO);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.nodes[0]!.files, ['src/api/', 'README.md']);
  assert.match(r.warnings[0]!, /1 file reference/);
});

test('structural problems reject the map', () => {
  assert.equal(validateMap({ nodes: [], edges: [] }, REPO).ok, false);
  assert.equal(validateMap({ nodes: [node('a', null), node('a', null)], edges: [] }, REPO).ok, false);
  assert.equal(validateMap({ nodes: [node('a', 'ghost')], edges: [] }, REPO).ok, false);
  assert.equal(validateMap({ nodes: [node('a', 'b'), node('b', 'a')], edges: [] }, REPO).ok, false);
});

test('bad edges are dropped, not fatal', () => {
  const r = validateMap({
    nodes: [node('a', null), node('b', null)],
    edges: [{ from: 'a', to: 'b', label: 'x' }, { from: 'a', to: 'ghost', label: '' }, { from: 'a', to: 'a', label: '' }, { from: 'a', to: 'b', label: 'x' }],
  }, REPO);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.edges.length, 1);
});

test('staleness marks the covering node and its ancestors', () => {
  const nodes = [node('api', null, ['src/api/']), node('orders', 'api', ['src/api/orders.ts']), node('worker', null, ['src/worker/'])];
  assert.deepEqual(staleNodeIds(nodes, ['src/api/orders.ts']).sort(), ['api', 'orders']);
  assert.deepEqual(staleNodeIds(nodes, ['README.md']), []);
});

test('the generator may only read', () => {
  const P = '/repo';
  assert.equal(generatorDecision('Read', { file_path: '/repo/a' }, P).bucket, 'allow');
  assert.equal(generatorDecision('Bash', { command: 'git ls-files' }, P).bucket, 'allow');
  assert.equal(generatorDecision('StructuredOutput', {}, P).bucket, 'allow');
  assert.equal(generatorDecision('Edit', { file_path: '/repo/a' }, P).bucket, 'deny');
  assert.equal(generatorDecision('Bash', { command: 'sudo systemctl restart docker' }, P).bucket, 'deny');
  assert.equal(generatorDecision('Bash', { command: 'cat a > b' }, P).bucket, 'deny'); // redirection writes a file
});

test('a folder of repositories is one project: files are prefixed per repo, changes tracked per repo', () => {
  const root = mkdtempSync(join(tmpdir(), 'fd-multi-'));
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    for (const r of ['api', 'web']) {
      mkdirSync(join(root, r));
      writeFileSync(join(root, r, 'main.ts'), 'x');
      sh(join(root, r), 'init', '-q', '-b', 'main');
      sh(join(root, r), 'add', '.');
      sh(join(root, r), '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x');
    }
    mkdirSync(join(root, 'notes')); // not a repository: left out
    writeFileSync(join(root, 'notes', 'n.md'), 'x');
    writeFileSync(join(root, 'CLAUDE.md'), 'x');

    assert.deepEqual(repoDirs(root), ['api', 'web']);
    assert.deepEqual(repoFiles(root).sort(), ['CLAUDE.md', 'api/main.ts', 'web/main.ts']);

    const commits = { api: sh(join(root, 'api'), 'rev-parse', 'HEAD'), web: sh(join(root, 'web'), 'rev-parse', 'HEAD') };
    const map = { commit: null, commits, generatedAt: new Date(Date.now() + 60_000).toISOString() };
    assert.deepEqual(changedSince(root, map), []);
    writeFileSync(join(root, 'web', 'main.ts'), 'y');
    assert.deepEqual(changedSince(root, map), ['web/main.ts']);
    assert.equal(changedSince(root, { ...map, commits: { ...commits, api: 'f'.repeat(40) } }), null); // commit gone
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('edge evidence is kept only when the cited file exists; the edge itself always stays', () => {
  const r = validateMap({
    nodes: [node('api', null, ['src/api/']), node('worker', null, ['src/worker/'])],
    edges: [
      { from: 'api', to: 'worker', label: 'enqueues', evidence: './src/api/orders.ts:42' },
      { from: 'worker', to: 'api', label: 'reports', evidence: 'src/made-up.ts' },
      { from: 'api', to: 'worker', label: 'pings' },
    ],
  }, REPO);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.edges.map(e => [e.label, e.evidence]), [['enqueues', 'src/api/orders.ts:42'], ['reports', undefined], ['pings', undefined]]);
  assert.ok(r.warnings.some(w => w.includes('inferred')));
});
