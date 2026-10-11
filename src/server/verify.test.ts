import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanBody, type MapNode, type StoredMap } from '../shared/contracts.ts';

process.env.FLIGHTDECK_DATA = join(mkdtempSync(join(tmpdir(), 'fd-verify-')), 'data');
const { assess, countResults, generationHints } = await import('./verify.ts');

const node = (id: string, parent: string | null, files: string[]): MapNode =>
  ({ id, parent, label: id, kind: 'module', summary: '', files, fields: [] });
const map = (nodes: MapNode[], edges: StoredMap['edges'] = []): StoredMap =>
  ({ version: 1, view: 'architecture', generatedAt: 'x', commit: null, model: 'm', warnings: [], nodes, edges });

const BEFORE = map(
  [node('api', null, ['src/api/']), node('legacy', 'api', ['src/api/legacy.ts']), node('db', null, ['src/db.ts']), node('web', null, ['src/web/'])],
  [{ from: 'web', to: 'api', label: 'HTTP', evidence: 'src/web/client.ts:3' }],
);
const PLAN = PlanBody.parse({
  title: 'T', summary: 'S',
  changes: { architecture: {
    addNodes: [
      { ...node('billing', 'api', ['src/api/billing.ts']), why: 'x' },
      { ...node('ghost', 'api', ['src/api/ghost.ts']), why: 'x' },
      { ...node('drawn', 'api', ['src/api/drawn.ts']), why: 'x' },
    ],
    changeNodes: [{ id: 'db', summary: 'pg', why: 'x' }, { id: 'web', summary: 'spa', why: 'x' }],
    removeNodes: [{ id: 'legacy', why: 'x' }],
    addEdges: [{ from: 'billing', to: 'db', label: 'writes', why: 'x' }, { from: 'drawn', to: 'db', label: 'reads', why: 'x' }],
    removeEdges: [{ from: 'web', to: 'api', why: 'x' }],
  } },
});
const AFTER = map(
  [
    node('api', null, ['src/api/']), node('db', null, ['src/db.ts']), node('web', null, ['src/web/']),
    node('billing', 'api', ['src/api/billing.ts']),
    node('drawn', 'api', ['src/api/drawn.ts']), // drawn by the generator, but no code behind it changed
    node('cron', null, ['src/cron.ts']), // not in the plan
  ],
  [
    { from: 'billing', to: 'db', label: 'writes', evidence: 'src/api/billing.ts:12' },
    { from: 'drawn', to: 'db', label: 'reads' }, // not cited
  ],
);
const CHANGED = ['src/api/billing.ts', 'src/db.ts', 'src/api/legacy.ts', 'src/web/client.ts', 'src/cron.ts', 'scripts/deploy.sh'];
const EXISTS = new Set(['src/api/billing.ts', 'src/db.ts', 'src/cron.ts', 'src/web/client.ts', 'scripts/deploy.sh']);

const items = assess({ body: PLAN, before: { architecture: BEFORE }, after: { architecture: AFTER }, changed: CHANGED, exists: f => EXISTS.has(f) });
const result = (id: string) => items.find(i => i.id === id)?.result;

test('a planned part is Verified only with code evidence, and the diagram aligned', () => {
  assert.equal(result('billing'), 'verified');
  assert.equal(result('db'), 'verified');
  assert.equal(result('billing→db'), 'verified'); // cited in a file that changed
});

test('a node that exists only in the regenerated diagram is not Verified', () => {
  assert.equal(result('drawn'), 'review');
  assert.equal(result('drawn→db'), 'review'); // drawn, never cited in code
});

test('no trace is Missing; a changed node whose files never changed is Missing', () => {
  assert.equal(result('ghost'), 'missing');
  assert.equal(result('web'), 'verified'); // src/web/client.ts changed
  const untouched = assess({ body: PLAN, before: { architecture: BEFORE }, after: { architecture: AFTER }, changed: [], exists: () => false });
  assert.equal(untouched.find(i => i.id === 'db')?.result, 'missing');
});

test('removals: gone from the map with its files changed or deleted', () => {
  assert.equal(result('legacy'), 'verified');
  assert.equal(result('web→api'), 'verified'); // the cited call's file changed and the edge is gone
});

test('changes no planned part accounts for are Unexpected', () => {
  assert.equal(result('cron'), 'unexpected');
  assert.equal(result('scripts/deploy.sh'), 'unexpected');
  assert.equal(result('src/api/billing.ts'), undefined); // claimed by billing
});

test('without a regenerated map nothing can be Verified', () => {
  const noMap = assess({ body: PLAN, before: { architecture: BEFORE }, after: {}, changed: CHANGED, exists: f => EXISTS.has(f) });
  assert.equal(countResults(noMap).verified, 0);
  assert.equal(noMap.find(i => i.id === 'billing')?.result, 'review');
});

test('generation hints give old and planned ids, as names only', () => {
  const h = generationHints(PLAN, 'architecture', { architecture: BEFORE });
  assert.match(h, /include a part only if it exists in the code/);
  assert.match(h, /- legacy: legacy/);
  assert.match(h, /- billing: billing \(module\)/);
});
