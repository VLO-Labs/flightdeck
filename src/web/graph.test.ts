import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MapEdge, MapNode } from '../shared/contracts.ts';
import { liftEdges } from './graph.ts';

const node = (id: string, parent: string | null): MapNode =>
  ({ id, parent, label: id, kind: 'module', summary: '', files: [], fields: [] });
const edge = (from: string, to: string, label = ''): MapEdge => ({ from, to, label });

// web ─┐            api ─┐
//      └ web.client      └ api.routes
const NODES = [node('web', null), node('web.client', 'web'), node('api', null), node('api.routes', 'api'), node('db', null)];

test('edges between children are lifted to their visible ancestors, keeping direction and labels', () => {
  const lifted = liftEdges(NODES, [edge('web.client', 'api.routes', 'HTTP'), edge('api.routes', 'db', 'SQL')], null);
  assert.deepEqual(lifted, [
    { from: 'web', to: 'api', labels: ['HTTP'], parts: [{ label: 'HTTP', evidence: undefined }], twoWay: false },
    { from: 'api', to: 'db', labels: ['SQL'], parts: [{ label: 'SQL', evidence: undefined }], twoWay: false },
  ]);
});

test('A→B and B→A become one two-way edge with both labels; nothing is invented', () => {
  const lifted = liftEdges(NODES, [edge('web', 'api', 'calls'), { ...edge('api', 'web', 'pushes'), evidence: 'src/push.ts:9' }], null);
  assert.deepEqual(lifted, [{
    from: 'web', to: 'api', labels: ['calls', 'pushes'], twoWay: true,
    parts: [{ label: 'calls', evidence: undefined }, { label: 'pushes', evidence: 'src/push.ts:9' }],
  }]);
});

test('edges inside one visible node, or leaving the level, are not drawn', () => {
  assert.deepEqual(liftEdges(NODES, [edge('web.client', 'web')], null), []);
  assert.deepEqual(liftEdges(NODES, [edge('api.routes', 'db')], 'api'), []); // db is not inside api
});
