import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A throwaway database and repository; db.ts reads FLIGHTDECK_DATA when it loads.
const root = mkdtempSync(join(tmpdir(), 'fd-plans-'));
process.env.FLIGHTDECK_DATA = join(root, 'data');
const repo = join(root, 'repo');
const { approve, approvedVersion, captureBaseline, changedSinceBaseline, currentMaps, drop, planResponse, planStatusLine, revalidate, submitProposal, versionMaps } = await import('./plans.ts');
const { db, planVersions } = await import('./db.ts');
const { eq } = await import('drizzle-orm');

const sh = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
const write = (f: string, s: string) => { mkdirSync(join(repo, f, '..'), { recursive: true }); writeFileSync(join(repo, f), s); };
mkdirSync(repo);
sh('init', '-q'); sh('config', 'user.email', 't@t'); sh('config', 'user.name', 't');
write('src/api/orders.ts', 'orders'); write('src/db.ts', 'db'); write('README.md', 'hi');
write('.flightdeck/architecture.json', JSON.stringify({
  version: 1, view: 'architecture', generatedAt: '2026-10-11T00:00:00Z', commit: null, model: 'm', warnings: [],
  nodes: [
    { id: 'api', parent: null, label: 'API', kind: 'service', summary: '', files: ['src/api/'], fields: [] },
    { id: 'db', parent: null, label: 'DB', kind: 'datastore', summary: '', files: ['src/db.ts'], fields: [] },
  ],
  edges: [{ from: 'api', to: 'db', label: 'writes' }],
}));
sh('add', '.'); sh('commit', '-qm', 'init');
const project = { id: 1, path: repo, mapsRepo: null };

const PROPOSAL = {
  title: 'Billing', summary: 'Add billing',
  changes: { architecture: { addNodes: [{ id: 'billing', parent: 'api', label: 'Billing', kind: 'module', summary: 'charges', files: ['src/api/billing.ts'], fields: [], why: 'charge' }],
    changeNodes: [{ id: 'db', summary: 'adds invoices', why: 'store invoices' }] } },
};
const state = (chatId: number) => planResponse(chatId, project).version!.freshness.state;

test.after(() => rmSync(root, { recursive: true, force: true }));

test('a proposal is validated and saved as a version with a baseline', () => {
  assert.equal(submitProposal(1, project, { title: 'x' }).ok, false);
  const bad = submitProposal(1, project, { ...PROPOSAL, changes: { architecture: { removeNodes: [{ id: 'ghost', why: 'x' }] } } });
  assert.ok(!bad.ok && /no such node/.test(bad.errors[0]!));
  const r = submitProposal(1, project, PROPOSAL);
  assert.ok(r.ok);
  const res = planResponse(1, project);
  assert.equal(res.plan?.status, 'draft');
  assert.equal(res.version?.version, 1);
  assert.equal(res.version?.baseline.repos['']?.head, sh('rev-parse', 'HEAD').trim());
  assert.equal(state(1), 'fresh');
});

test('freshness: changes elsewhere, changes the plan covers, and uncommitted work at the baseline', () => {
  write('README.md', 'changed');
  assert.equal(state(1), 'elsewhere');
  write('src/api/orders.ts', 'changed'); // next to where the plan adds billing, but not in it
  assert.equal(state(1), 'elsewhere');
  write('src/db.ts', 'changed'); // the DB node the plan changes
  assert.equal(state(1), 'stale');
  assert.deepEqual(planResponse(1, project).version!.freshness.touched, ['src/db.ts']);

  // A version made on top of that uncommitted work is fresh until that work changes again.
  const r = submitProposal(1, project, PROPOSAL);
  assert.ok(r.ok && r.version.version === 2);
  assert.equal(state(1), 'fresh');
  sh('add', '.'); sh('commit', '-qm', 'same content, now committed');
  assert.equal(state(1), 'fresh');
  write('src/db.ts', 'changed again');
  assert.equal(state(1), 'stale');
});

test('a commit the baseline names going away makes the version stale', () => {
  const baseline = captureBaseline(project, currentMaps(project));
  baseline.repos['']!.head = '0'.repeat(40);
  assert.equal(changedSinceBaseline(project, baseline), null);
});

test('a stale version is not approved; revalidating saves the same plan with a new baseline', () => {
  const stale = planResponse(1, project).version!;
  assert.equal(stale.freshness.state, 'stale');
  const refused = approve(1, project, stale.id);
  assert.ok(!refused.ok && /revalidate/.test(refused.error));
  const re = revalidate(1, project, stale.id);
  assert.ok(re.ok && re.version.source === 'revalidated' && re.version.version === 3);
  assert.equal(state(1), 'fresh');
  assert.ok(approve(1, project, re.version.id).ok);
  assert.deepEqual(approvedVersion(1)?.version, 3);
});

test('approved versions are immutable; new proposals do not change what Build implements', () => {
  const approved = approvedVersion(1)!;
  assert.throws(() => db.update(planVersions).set({ body: '{}' }).where(eq(planVersions.id, approved.id)).run(), /immutable/);
  assert.throws(() => db.update(planVersions).set({ approvedAt: null }).where(eq(planVersions.id, approved.id)).run(), /approved once/);
  assert.throws(() => db.delete(planVersions).where(eq(planVersions.id, approved.id)).run(), /kept/);
  assert.throws(() => db.update(planVersions).set({ maps: '{}' }).where(eq(planVersions.id, approved.id)).run(), /immutable/);
  const r = submitProposal(1, project, { ...PROPOSAL, title: 'Billing v2' });
  assert.ok(r.ok && r.version.version === 4);
  assert.equal(approvedVersion(1)?.version, 3);
  assert.equal(planResponse(1, project).plan?.status, 'approved');
});

test('versions belong to their chat; a dropped plan has no build spec', () => {
  const other = submitProposal(2, project, PROPOSAL);
  assert.ok(other.ok);
  assert.equal(approve(1, project, other.version.id).ok, false);
  assert.match(planStatusLine(1), /v3 is APPROVED.*latest version is v4 \(a draft/);
  assert.ok(drop(1, 'user'));
  assert.equal(drop(1, 'user'), false); // already dropped
  assert.match(planStatusLine(1), /DROPPED/);
  assert.equal(approvedVersion(1), null);
  assert.equal(approve(1, project, planResponse(1, project).version!.id).ok, false);
});

test("a version keeps the maps it was made against, whatever happens to the map files", () => {
  const r = submitProposal(3, project, PROPOSAL);
  assert.ok(r.ok);
  const file = join(repo, '.flightdeck/architecture.json');
  const regenerated = JSON.parse(readFileSync(file, 'utf8'));
  regenerated.generatedAt = '2026-10-12T00:00:00Z';
  regenerated.nodes.push({ id: 'billing', parent: 'api', label: 'Billing', kind: 'module', summary: '', files: ['src/api/billing.ts'], fields: [] });
  writeFileSync(file, JSON.stringify(regenerated));
  const row = db.select().from(planVersions).where(eq(planVersions.id, r.version.id)).get()!;
  const kept = versionMaps(row, project).architecture!;
  assert.equal(kept.generatedAt, '2026-10-11T00:00:00Z');
  assert.equal(kept.nodes.some(n => n.id === 'billing'), false);
  assert.equal(currentMaps(project).architecture!.nodes.some(n => n.id === 'billing'), true);
});
