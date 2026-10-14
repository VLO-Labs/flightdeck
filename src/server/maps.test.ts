import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MapNode } from '../shared/contracts.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { changedSince, generatorDecision, mapsDir, moveMaps, repoBaselines, repoDirs, repoFiles, staleNodeIds, validateMap } from './maps.ts';

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
    const map = { commit: null, commits, repos: repoBaselines(root), generatedAt: new Date(Date.now() + 60_000).toISOString() };
    assert.deepEqual(changedSince(root, map), []);
    writeFileSync(join(root, 'web', 'main.ts'), 'y');
    assert.deepEqual(changedSince(root, map), ['web/main.ts']);
    assert.equal(changedSince(root, { ...map, repos: { ...map.repos, api: { head: 'f'.repeat(40), dirty: {} } } }), null); // commit gone
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('uncommitted work already there when the map was made is not a change; editing it again is', () => {
  const root = mkdtempSync(join(tmpdir(), 'fd-dirty-'));
  const sh = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    writeFileSync(join(root, 'a.ts'), 'x');
    writeFileSync(join(root, 'b.ts'), 'x');
    sh('init', '-q', '-b', 'main');
    sh('add', '.');
    sh('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x');
    writeFileSync(join(root, 'a.ts'), 'edited before the map');
    writeFileSync(join(root, 'new.ts'), 'untracked before the map');

    const map = { commit: sh('rev-parse', 'HEAD'), repos: repoBaselines(root), generatedAt: new Date().toISOString() };
    assert.deepEqual(changedSince(root, map), []);
    sh('add', '.');
    sh('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'y'); // committing it unchanged isn't a change either
    assert.deepEqual(changedSince(root, map), []);
    writeFileSync(join(root, 'new.ts'), 'edited after');
    writeFileSync(join(root, 'b.ts'), 'edited after');
    assert.deepEqual(changedSince(root, map)!.sort(), ['b.ts', 'new.ts']);

    // A map from before baselines: files not modified since it was made are left out.
    const old = { commit: map.commit, generatedAt: new Date(Date.now() + 60_000).toISOString() };
    assert.deepEqual(changedSince(root, old), []);
    assert.deepEqual(changedSince(root, { ...old, generatedAt: '2000-01-01T00:00:00Z' })!.sort(), ['a.ts', 'b.ts', 'new.ts']);
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

test('a multi-repo folder can keep its maps in one repo; moving them keeps an existing map at the destination', () => {
  const root = mkdtempSync(join(tmpdir(), 'fd-mapsdir-'));
  try {
    assert.equal(mapsDir({ path: root, mapsRepo: null }), join(root, '.flightdeck'));
    const inRepo = mapsDir({ path: root, mapsRepo: 'api' });
    assert.equal(inRepo, join(root, 'api', '.flightdeck', basename(root)));
    mkdirSync(join(root, '.flightdeck'));
    writeFileSync(join(root, '.flightdeck', 'architecture.json'), 'old-arch');
    writeFileSync(join(root, '.flightdeck', 'flows.json'), 'old-flows');
    mkdirSync(inRepo, { recursive: true });
    writeFileSync(join(inRepo, 'flows.json'), 'kept');
    assert.deepEqual(moveMaps(join(root, '.flightdeck'), inRepo), ['architecture']);
    assert.equal(readFileSync(join(inRepo, 'architecture.json'), 'utf8'), 'old-arch');
    assert.equal(readFileSync(join(inRepo, 'flows.json'), 'utf8'), 'kept');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
