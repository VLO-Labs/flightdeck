import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanBody, type MapNode, type StoredMap } from './contracts.ts';
import { applyPlan, cleanPath, planAsText, planCounts, planFiles, validatePlan } from './plan.ts';

const node = (id: string, parent: string | null, files: string[] = []): MapNode =>
  ({ id, parent, label: id, kind: 'module', summary: '', files, fields: [] });
const MAP: StoredMap = {
  version: 1, view: 'architecture', generatedAt: '2026-10-11T00:00:00Z', commit: 'abc', model: 'm', warnings: [],
  nodes: [node('web', null, ['src/web/']), node('api', null, ['src/api/']), node('orders', 'api', ['src/api/orders.ts']), node('db', null, ['src/db.ts'])],
  edges: [{ from: 'web', to: 'api', label: 'HTTP' }, { from: 'orders', to: 'db', label: 'writes orders' }],
};
const maps = { architecture: MAP };
const plan = (changes: object, extra: object = {}) =>
  PlanBody.parse({ title: 'T', summary: 'S', changes: { architecture: changes }, ...extra });

test('a sound plan passes', () => {
  const p = plan({
    addNodes: [{ ...node('billing', 'api', ['src/api/billing.ts']), why: 'charge orders' }],
    changeNodes: [{ id: 'db', summary: 'Postgres', why: 'move off SQLite' }],
    addEdges: [{ from: 'billing', to: 'db', label: 'writes invoices', why: 'persist' }],
    removeEdges: [{ from: 'web', to: 'api', why: 'replaced' }],
  }, { steps: [{ text: 'add billing', nodes: ['architecture:billing', 'architecture:db'] }] });
  assert.deepEqual(validatePlan(p, maps), []);
  assert.deepEqual(planCounts(p), { added: 2, changed: 1, removed: 1 });
});

test('greenfield: with no map yet, everything is added', () => {
  const p = plan({ addNodes: [{ ...node('app', null, ['src/']), why: 'start' }, { ...node('ui', 'app'), why: 'screens' }] });
  assert.deepEqual(validatePlan(p, {}), []);
  const m = applyPlan(null, p.changes.architecture);
  assert.deepEqual(m.nodes.map(n => [n.id, n.status]), [['app', 'added'], ['ui', 'added']]);
});

test('bad references are errors the agent gets back', () => {
  const errs = (changes: object, extra?: object) => validatePlan(plan(changes, extra), maps);
  assert.match(errs({ addNodes: [{ ...node('api', null), why: 'x' }] })[0]!, /existing node/);
  assert.match(errs({ changeNodes: [{ id: 'ghost', why: 'x' }] })[0]!, /no such node/);
  assert.match(errs({ removeNodes: [{ id: 'ghost', why: 'x' }] })[0]!, /no such node/);
  assert.match(errs({ addNodes: [{ ...node('x', 'nope'), why: 'x' }] })[0]!, /doesn't exist/);
  assert.match(errs({ addNodes: [{ ...node('x', 'api'), why: 'x' }], removeNodes: [{ id: 'api', why: 'x' }] })[0]!, /being removed/);
  assert.match(errs({ addNodes: [{ ...node('a', 'b'), why: 'x' }, { ...node('b', 'a'), why: 'x' }] }).join(), /cycle/);
  assert.match(errs({ removeNodes: [{ id: 'api', why: 'x' }], addEdges: [{ from: 'orders', to: 'db', label: '', why: 'x' }] })[0]!, /removed/);
  assert.match(errs({ removeEdges: [{ from: 'db', to: 'web', why: 'x' }] })[0]!, /not in the current map/);
  assert.match(errs({ changeNodes: [{ id: 'orders', why: 'x' }], removeNodes: [{ id: 'api', why: 'x' }] })[0]!, /changed and removed/);
  assert.match(errs({ addNodes: [{ ...node('x', null, ['../etc/passwd']), why: 'x' }] })[0]!, /without "\.\."/);
  assert.match(errs({})[0]!, /changes nothing/);
  assert.match(errs({ changeNodes: [{ id: 'db', why: 'x' }] }, { steps: [{ text: 's', nodes: ['db'] }] })[0]!, /view:id/);
});

test('the overlay keeps the map, marks changes, and removes what is inside a removed node', () => {
  const p = plan({
    addNodes: [{ ...node('billing', 'api'), why: 'new' }],
    changeNodes: [{ id: 'web', label: 'Web app', why: 'rename' }],
    removeNodes: [{ id: 'api', why: 'merge' }],
  });
  const m = applyPlan(MAP, p.changes.architecture);
  const st = Object.fromEntries(m.nodes.map(n => [n.id, n.status ?? 'same']));
  assert.deepEqual(st, { web: 'changed', api: 'removed', orders: 'removed', db: 'same', billing: 'added' });
  const web = m.nodes.find(n => n.id === 'web')!;
  assert.equal(web.label, 'Web app');
  assert.equal(web.before?.label, 'web');
  // Edges touching a removed node go with it.
  assert.deepEqual(m.edges.map(e => e.status ?? 'same'), ['removed', 'removed']);
  // The map itself is untouched.
  assert.equal(MAP.nodes[0]!.label, 'web');
});

test('the files a plan works in', () => {
  const p = plan({
    addNodes: [{ ...node('billing', 'api', ['src/api/billing.ts']), why: 'x' }],
    changeNodes: [{ id: 'db', why: 'x' }],
    removeNodes: [{ id: 'api', why: 'x' }],
  });
  assert.deepEqual(planFiles(p, maps).sort(), ['src/api/', 'src/api/billing.ts', 'src/api/orders.ts', 'src/db.ts']);
});

test('paths stay inside the project', () => {
  assert.equal(cleanPath('./src/a.ts'), 'src/a.ts');
  for (const p of ['/etc/passwd', '../x', 'a/../../x', 'C:/x', '']) assert.equal(cleanPath(p), null, p);
});

test('the approved plan as Build reads it', () => {
  const p = plan({
    addNodes: [{ ...node('billing', 'api', ['src/api/billing.ts']), why: 'charge orders' }],
    changeNodes: [{ id: 'db', summary: 'Postgres', why: 'scale' }],
    removeEdges: [{ from: 'web', to: 'api', why: 'replaced' }],
  }, { steps: [{ text: 'add billing', nodes: [] }] });
  const t = planAsText(p, 3, maps);
  assert.match(t, /^Approved plan v3: T/);
  assert.match(t, /ADD module "billing" \[billing\] inside "api"/);
  assert.match(t, /files: src\/api\/billing.ts/);
  assert.match(t, /CHANGE "db" \[db\]: summary → "Postgres" — scale/);
  assert.match(t, /DISCONNECT "web" → "api"/);
  assert.match(t, /1\. add billing/);
});

test('after a build, planned parts already on the map are marked, not drawn twice', () => {
  const built: StoredMap = { ...MAP, nodes: [...MAP.nodes, node('billing', 'api')], edges: [...MAP.edges, { from: 'billing', to: 'db', label: 'w' }] };
  const p = plan({
    addNodes: [{ ...node('billing', 'api'), why: 'x' }],
    addEdges: [{ from: 'billing', to: 'db', label: 'writes', why: 'x' }],
  });
  const m = applyPlan(built, p.changes.architecture);
  assert.equal(m.nodes.filter(n => n.id === 'billing').length, 1);
  assert.equal(m.nodes.find(n => n.id === 'billing')?.status, 'added');
  assert.equal(m.edges.filter(e => e.from === 'billing').length, 1);
  assert.equal(m.edges.find(e => e.from === 'billing')?.status, 'added');
});
