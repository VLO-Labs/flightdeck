import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A throwaway database and repository; db.ts reads FLIGHTDECK_DATA when it loads.
const root = mkdtempSync(join(tmpdir(), 'fd-req-'));
process.env.FLIGHTDECK_DATA = join(root, 'data');
const repo = join(root, 'repo');
const { RequirementsError, approveRequirement, getRequirement, hashOf, isRequirementsPath, listRequirements, saveRequirement } = await import('./requirements.ts');
const { db, requirementApprovals } = await import('./db.ts');
const { eq } = await import('drizzle-orm');

const sh = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
mkdirSync(repo);
sh('init', '-q'); sh('config', 'user.email', 't@t'); sh('config', 'user.name', 't');
writeFileSync(join(repo, 'README.md'), 'hi');
sh('add', '.'); sh('commit', '-qm', 'init');
const project = { id: 1, path: repo, mapsRepo: null };
const file = join(repo, 'docs/requirements/PRD.md');

const fails = (f: () => unknown, status: number, match?: RegExp) => {
  try { f(); } catch (e) {
    assert.ok(e instanceof RequirementsError, String(e));
    assert.equal(e.status, status);
    if (match) assert.match(e.message, match);
    return e;
  }
  assert.fail('expected a refusal');
};

const V1 = '# Shop\n\n## Business rules\n\n### BR-001 · Orders need a payment\nAlways.\n';

test('the PRD is listed before it exists, created on first save, and starts as a draft', () => {
  assert.deepEqual(listRequirements(project).docs.map(d => [d.path, d.hash, d.state]), [['PRD.md', null, 'draft']]);
  const doc = saveRequirement(project, 'PRD.md', V1, null);
  assert.equal(readFileSync(file, 'utf8'), V1);
  assert.equal(doc.summary.state, 'draft');
  assert.equal(doc.summary.git, 'untracked');
  assert.deepEqual(doc.summary.ids, ['BR-001']);
  // No temporary files left beside it.
  assert.deepEqual(readdirSync(join(repo, 'docs/requirements')), ['PRD.md']);
});

test('a save is refused when the file changed since editing began, with the current text', () => {
  writeFileSync(file, V1 + '\nEdited in an IDE.\n');
  const e = fails(() => saveRequirement(project, 'PRD.md', V1 + 'mine', hashOf(V1)), 409, /changed since you started/);
  assert.equal(e.current?.content, V1 + '\nEdited in an IDE.\n');
  // Creating over an existing file is the same conflict.
  fails(() => saveRequirement(project, 'PRD.md', 'x', null), 409);
  saveRequirement(project, 'PRD.md', V1, hashOf(V1 + '\nEdited in an IDE.\n'));
});

test('approve freezes the reviewed text; a later edit is a new draft revision, the approval stays', () => {
  fails(() => approveRequirement(project, 'PRD.md', hashOf('something else')), 409, /changed since you reviewed/);
  const a = approveRequirement(project, 'PRD.md', hashOf(V1));
  assert.equal(a.summary.state, 'approved');
  assert.equal(a.summary.approved?.version, 1);
  // Approving the same text again adds nothing.
  assert.equal(approveRequirement(project, 'PRD.md', hashOf(V1)).versions.length, 1);

  const V2 = V1 + '\n### BR-002 · Refunds need a reason\n';
  const b = saveRequirement(project, 'PRD.md', V2, hashOf(V1));
  assert.equal(b.summary.state, 'changed');
  assert.equal(b.summary.approved?.version, 1);
  assert.equal(getRequirement(project, 'PRD.md', 1).viewing?.content, V1);
  const c = approveRequirement(project, 'PRD.md', hashOf(V2));
  assert.deepEqual(c.versions.map(v => v.version), [2, 1]);

  // The table refuses edits and deletes, whatever asks.
  assert.throws(() => db.update(requirementApprovals).set({ content: 'rewritten' }).where(eq(requirementApprovals.version, 1)).run(), /immutable/);
  assert.throws(() => db.delete(requirementApprovals).run(), /kept/);

  // Deleting the file doesn't lose the document.
  rmSync(file);
  assert.equal(listRequirements(project).docs[0]!.state, 'missing');
  saveRequirement(project, 'PRD.md', V2, null);
});

test('ids: an approved id cannot vanish or be reused by another document', () => {
  const cur = readFileSync(file, 'utf8');
  fails(() => saveRequirement(project, 'PRD.md', cur.replace(/### BR-002[^\n]*\n/, ''), hashOf(cur)), 400, /Removed: BR-002/);
  const retired = cur.replace('### BR-002 · Refunds need a reason', '### ~~BR-002~~ Refunds need a reason (retired)');
  saveRequirement(project, 'PRD.md', retired, hashOf(cur));
  fails(() => saveRequirement(project, 'features/checkout.md', '# Checkout\n- **BR-001** clash\n', null), 400, /another document: BR-001/);
  const f = saveRequirement(project, 'features/checkout.md', '# Checkout\n\n## Acceptance criteria\n- **AC-001** Paid orders are confirmed\n', null);
  assert.deepEqual(f.summary.ids, ['AC-001']);
  assert.deepEqual(listRequirements(project).docs.map(d => d.path), ['PRD.md', 'features/checkout.md']);
});

test('only the fixed names, never through a symlink, never outside the repository', () => {
  for (const bad of ['../README.md', 'features/../../README.md', 'notes.md', '/etc/passwd', 'features/a/b.md'])
    fails(() => saveRequirement(project, bad, 'x', null), 400, /not a requirements document/);
  const outside = join(root, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(repo, 'docs/requirements/features/evil.md'));
  fails(() => saveRequirement(project, 'features/evil.md', 'x', null), 400, /symlink/);
  rmSync(join(repo, 'docs/requirements/features/evil.md'));
  // A symlinked folder on the way.
  rmSync(join(repo, 'docs'), { recursive: true });
  symlinkSync(outside, join(repo, 'docs'));
  fails(() => saveRequirement(project, 'PRD.md', 'x', null), 400, /symlink/);
  assert.equal(existsSync(join(outside, 'requirements')), false);
  rmSync(join(repo, 'docs'));
});

test('the hook recognises requirements paths, whatever the case or a link in between', () => {
  assert.ok(isRequirementsPath(project, join(repo, 'docs/requirements/PRD.md')));
  assert.ok(isRequirementsPath(project, join(repo, 'Docs/Requirements/features/x.md')));
  assert.ok(isRequirementsPath(project, 'docs/requirements/new.md'));
  assert.ok(!isRequirementsPath(project, join(repo, 'docs/other.md')));
  assert.ok(!isRequirementsPath(project, join(repo, 'src/requirements.ts')));
  mkdirSync(join(repo, 'docs/requirements'), { recursive: true });
  writeFileSync(join(repo, 'docs/requirements/PRD.md'), 'x');
  symlinkSync(join(repo, 'docs/requirements/PRD.md'), join(repo, 'innocent.md'));
  assert.ok(isRequirementsPath(project, join(repo, 'innocent.md')));
  // Multi-repo: inside the maps repo.
  assert.ok(isRequirementsPath({ ...project, mapsRepo: 'api' }, join(repo, 'api/docs/requirements/PRD.md')));
  assert.ok(!isRequirementsPath({ ...project, mapsRepo: 'api' }, join(repo, 'web/docs/other.md')));
});

test('context: a requirement or section read from the file, with the revision it is', async () => {
  const { resolveRequirementRef } = await import('./requirements.ts');
  writeFileSync(file, V1 + '\n### ~~BR-002~~ Refunds need a reason (retired)\n'); // as an editor would
  const r = resolveRequirementRef(project, 'PRD.md', 'BR-001');
  assert.equal(r.label, 'BR-001 Orders need a payment');
  assert.match(r.text, /^### BR-001 · Orders need a payment\nAlways\./);
  assert.match(r.revision, /^draft: changed since approved v2$/);
  assert.match(resolveRequirementRef(project, 'PRD.md', '§Business rules').text, /^## Business rules/);
  fails(() => resolveRequirementRef(project, 'PRD.md', 'BR-999'), 404, /not in PRD.md any more/);
});

test('proposals: edits checked like a save, written only on Accept, refused once the file moved on', async () => {
  const { submitRequirementProposal, decideRequirementProposal, listRequirementProposals } = await import('./requirements.ts');
  const before = readFileSync(file, 'utf8');
  const bad = submitRequirementProposal(project, 7, 1, { path: 'PRD.md', summary: 'drop a rule', edits: [{ old_string: '### BR-001 · Orders need a payment', new_string: '' }] });
  assert.ok(!bad.ok && /Removed: BR-001/.test(bad.error));
  assert.ok(!submitRequirementProposal(project, 7, 1, { path: '../x.md', summary: 's', content: 'x' }).ok);
  assert.ok(!submitRequirementProposal(project, 7, 1, { path: 'PRD.md', summary: 's', content: 'whole' }).ok); // exists: use edits

  const a = submitRequirementProposal(project, 7, 1, { path: 'PRD.md', summary: 'first', edits: [{ old_string: 'Always.', new_string: 'Always, even for staff.' }] });
  const b = submitRequirementProposal(project, 7, 1, { path: 'PRD.md', summary: 'second', edits: [{ old_string: 'Always.', new_string: 'Always, no exceptions.' }] });
  assert.ok(a.ok && b.ok);
  assert.equal(readFileSync(file, 'utf8'), before); // proposing writes nothing
  const open = listRequirementProposals(project);
  assert.equal(open.find(x => x.id === a.id)?.status, 'superseded');
  assert.equal(open.find(x => x.id === b.id)?.status, 'open');

  const c = submitRequirementProposal(project, 8, 1, { path: 'features/refunds.md', summary: 'new spec', content: '# Refunds\n- **AC-002** A refund names its reason\n' });
  assert.ok(c.ok && c.created);

  // Accept b: the file now has it, as a draft.
  assert.equal(decideRequirementProposal(project, b.id, true).status, 'accepted');
  assert.match(readFileSync(file, 'utf8'), /Always, no exceptions\./);
  fails(() => decideRequirementProposal(project, b.id, true), 409, /already accepted/);

  // Another proposal made against the old text can't be applied any more.
  const d = submitRequirementProposal(project, 8, 1, { path: 'PRD.md', summary: 'late', edits: [{ old_string: 'Always, no exceptions.', new_string: 'Mostly.' }] });
  assert.ok(d.ok);
  writeFileSync(file, readFileSync(file, 'utf8') + '\nIDE edit.\n');
  fails(() => decideRequirementProposal(project, d.id, true), 409, /changed since this was proposed/);
  assert.equal(decideRequirementProposal(project, d.id, false).status, 'rejected');
  assert.doesNotMatch(readFileSync(file, 'utf8'), /Mostly\./);
});

test('Build: the approved text, refusals for unapproved parts, ids named in text, the status line', async () => {
  const { resolveApprovedRef, approvedRefsIn, requirementsStatusLine } = await import('./requirements.ts');
  // PRD.md: approved v2 holds BR-001 ("Always.") and BR-002; the file has moved on since. A feature
  // spec that was never approved (an earlier test removed the folder).
  mkdirSync(join(repo, 'docs/requirements/features'), { recursive: true });
  writeFileSync(join(repo, 'docs/requirements/features/checkout.md'), '# Checkout\n- **AC-001** Paid orders are confirmed\n');
  const r = resolveApprovedRef(project, 'PRD.md', 'BR-001');
  assert.equal(r.version, 2);
  assert.match(r.text, /Always\.$/); // the approved wording, not the file's
  assert.match(r.revision, /^approved v2; the file has unapproved changes since/);
  writeFileSync(file, readFileSync(file, 'utf8') + '\n### BR-003 · Draft only\n');
  fails(() => resolveApprovedRef(project, 'PRD.md', 'BR-003'), 400, /isn't in approved v2/);
  fails(() => resolveApprovedRef(project, 'features/checkout.md', 'AC-001'), 400, /never been approved/);

  const named = approvedRefsIn(project, 'Implement BR-001 and BR-003; see AC-001. BR-001 again. XBR-002 is not an id; ZZ-123 is in no document.', new Set());
  assert.deepEqual(named.items.map(i => [i.ref, i.auto]), [['BR-001', true]]);
  assert.deepEqual(named.unapproved.sort(), ['AC-001', 'BR-003']);
  assert.deepEqual(approvedRefsIn(project, 'BR-001', new Set(['BR-001'])).items, []); // already attached

  const line = requirementsStatusLine(project);
  assert.match(line, /PRD\.md has unapproved changes since v2/);
  assert.match(line, /features\/checkout\.md has never been approved/);
});

test('a draft can renumber or drop its ids until they are approved; then they are fixed', () => {
  const p2 = { ...project, id: 2 }; // a project of its own: no approvals yet
  const rel = 'features/onboarding.md';
  const a = saveRequirement(p2, rel, '# Onboarding\n- **AC-101** First\n- **AC-102** Second\n', null);
  // Not approved yet: dropping and renumbering are fine.
  const b = saveRequirement(p2, rel, '# Onboarding\n- **AC-101** First, reworded\n', a.summary.hash);
  approveRequirement(p2, rel, b.summary.hash!);
  fails(() => saveRequirement(p2, rel, '# Onboarding\n- **AC-201** Renumbered\n', b.summary.hash), 400, /Removed: AC-101\. Approved ids/);
  // An id added after the approval is a draft id again.
  const c = saveRequirement(p2, rel, '# Onboarding\n- **AC-101** First\n- **AC-103** New\n', b.summary.hash);
  saveRequirement(p2, rel, '# Onboarding\n- **AC-101** First\n- **AC-104** New, renumbered\n', c.summary.hash);
});
