import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_MIN_PX, SPLIT_DEFAULT, WORKSPACE_MIN_PX, clampSplit, forgetAll, isMapTab, isWorkspaceTab, recall, remember, toggleIn, type ContextRef } from './workspace.ts';

test('the divider keeps both panels at their minimum width', () => {
  assert.equal(clampSplit(35, 2000), 35);
  assert.equal(clampSplit(5, 2000), (CHAT_MIN_PX / 2000) * 100);
  assert.equal(clampSplit(95, 2000), 100 - (WORKSPACE_MIN_PX / 2000) * 100);
  assert.equal(clampSplit(Number.NaN, 2000), SPLIT_DEFAULT);
  // Too narrow for both: the layout goes one panel at a time, the stored value just stays in range.
  assert.equal(clampSplit(120, 600), 100);
});

test('workspace tabs: PRD, the three maps, code', () => {
  assert.ok(isWorkspaceTab('prd') && isWorkspaceTab('flows') && isWorkspaceTab('code'));
  assert.ok(!isWorkspaceTab('plan') && !isWorkspaceTab(undefined));
  assert.ok(isMapTab('data-model') && !isMapTab('prd'));
});

test('each chat keeps its own draft, context and tab', () => {
  forgetAll();
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  remember(1, { draft: 'half a thought', ctx: [{ view: 'architecture', nodeId: 'api', label: 'API' }], tab: 'flows' }, storage);
  remember(2, { draft: '', ctx: [], tab: 'prd' }, storage);
  assert.deepEqual(recall(1, storage).ctx.map(c => c.label), ['API']);
  assert.equal(recall(1, storage).tab, 'flows');
  assert.equal(recall(2, storage).draft, '');
  assert.equal(store.has('fd.draft.2'), false);
  // After a reload only the draft survives (context points at map nodes that may have changed).
  forgetAll();
  assert.deepEqual(recall(1, storage), { draft: 'half a thought', ctx: [] });
  assert.deepEqual(recall(3, storage), { draft: '', ctx: [] });
});

test('map nodes and requirements share one context list, toggled by identity', () => {
  const node: ContextRef = { view: 'architecture', nodeId: 'api', label: 'API' };
  const rule: ContextRef = { doc: 'PRD.md', ref: 'BR-001', label: 'BR-001 Pay first' };
  let cs = toggleIn(toggleIn([], node), rule);
  assert.equal(cs.length, 2);
  cs = toggleIn(cs, { doc: 'PRD.md', ref: 'BR-001', label: 'renamed' });
  assert.deepEqual(cs, [node]);
  // The same id in another document is a different requirement.
  assert.equal(toggleIn(toggleIn([], rule), { doc: 'features/x.md', ref: 'BR-001', label: '' }).length, 2);
});
