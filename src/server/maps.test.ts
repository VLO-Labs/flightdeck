import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MapNode } from '../shared/contracts.ts';
import { generatorDecision, staleNodeIds, validateMap } from './maps.ts';

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
