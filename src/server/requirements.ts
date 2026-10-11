// Requirements documents on disk (PLAN.md §11): read, save and approve the PRD and feature specs in
// <repo>/docs/requirements. The only code that writes there — the agent's edit tools are refused in the
// hook — and it writes nothing else: a fixed set of names, no symlinks anywhere on the way, the
// result always inside the project's real folder.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import type { ProposeRequirementsEdit, RequirementDoc, RequirementDocSummary, RequirementProposal, RequirementsResponse } from '../shared/contracts.ts';
import { PRD_FILE, REQUIREMENTS_DIR, checkRevision, findRef, isDocPath, parseRequirements } from '../shared/requirements.ts';
import { applyEdits } from '../shared/diff.ts';
import { db, chats, requirementApprovals, requirementProposals } from './db.ts';
import { git } from './maps.ts';

type ProjectLike = { id: number; path: string; mapsRepo: string | null };

export const hashOf = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');

// The repository that holds them: the project, or in a multi-repo folder the one that keeps the maps.
const repoRoot = (p: ProjectLike) => (p.mapsRepo ? join(p.path, p.mapsRepo) : p.path);
// Relative to the project folder, for display and for the hook.
export const requirementsDir = (p: ProjectLike) => (p.mapsRepo ? `${p.mapsRepo}/${REQUIREMENTS_DIR}` : REQUIREMENTS_DIR);

export class RequirementsError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400, readonly current?: { content: string | null; hash: string | null }) {
    super(message);
  }
}

// The document's absolute path, after checking every step from the repository down: each part that
// exists must be a real directory (the last a real file), never a symlink, so nothing leads out.
function locate(p: ProjectLike, rel: string, create = false): string {
  if (!isDocPath(rel)) throw new RequirementsError('not a requirements document path');
  let root: string;
  try { root = realpathSync(repoRoot(p)); } catch { throw new RequirementsError('the project folder is missing', 404); }
  const parts = [...REQUIREMENTS_DIR.split('/'), ...rel.split('/')];
  let at = root;
  for (const [i, part] of parts.entries()) {
    at = join(at, part);
    const last = i === parts.length - 1;
    let st;
    try { st = lstatSync(at); } catch { st = null; }
    if (st?.isSymbolicLink()) throw new RequirementsError(`${relative(root, at)} is a symlink; Flightdeck won't follow it`);
    if (!st) {
      if (!last && create) mkdirSync(at);
      continue;
    }
    if (last ? !st.isFile() : !st.isDirectory()) throw new RequirementsError(`${relative(root, at)} is not a ${last ? 'file' : 'folder'}`);
  }
  const inside = relative(root, at);
  if (inside.startsWith('..') || isAbsolute(inside) || inside.split(sep).includes('.git')) throw new RequirementsError('outside the project');
  return at;
}

function readCurrent(p: ProjectLike, rel: string): { content: string; hash: string } | null {
  const abs = locate(p, rel);
  if (!existsSync(abs)) return null;
  const content = readFileSync(abs, 'utf8');
  return { content, hash: hashOf(content) };
}

const approvalsOf = (projectId: number, rel: string) =>
  db.select().from(requirementApprovals)
    .where(and(eq(requirementApprovals.projectId, projectId), eq(requirementApprovals.path, rel)))
    .orderBy(desc(requirementApprovals.version)).all();

function gitState(p: ProjectLike, rel: string): RequirementDocSummary['git'] {
  const root = repoRoot(p);
  if (!existsSync(join(root, '.git'))) return 'none';
  try {
    const out = git(root, ['status', '--porcelain', '--', `${REQUIREMENTS_DIR}/${rel}`]);
    if (out.startsWith('??')) return 'untracked';
    return out.trim() ? 'modified' : 'committed';
  } catch {
    return 'none';
  }
}

function summarize(p: ProjectLike, rel: string, cur: { content: string; hash: string } | null): RequirementDocSummary {
  const latest = approvalsOf(p.id, rel)[0];
  const parsed = cur ? parseRequirements(cur.content) : latest ? parseRequirements(latest.content) : null;
  const state = !latest ? 'draft' : !cur ? 'missing' : cur.hash === latest.hash ? 'approved' : 'changed';
  return {
    path: rel,
    title: parsed?.title ?? null,
    hash: cur?.hash ?? null,
    state,
    approved: latest ? { version: latest.version, hash: latest.hash, approvedAt: latest.approvedAt } : null,
    git: cur ? gitState(p, rel) : 'none',
    ids: parsed?.items.map(i => i.id) ?? [],
  };
}

// Every document: the PRD (even before it exists, so the UI can offer to create it), each feature
// file, and any document that was approved but whose file is gone.
export function listRequirements(p: ProjectLike): RequirementsResponse {
  const rels = new Set<string>([PRD_FILE]);
  try {
    const dir = locate(p, PRD_FILE).replace(/PRD\.md$/, 'features');
    if (existsSync(dir) && !lstatSync(dir).isSymbolicLink()) {
      for (const f of readdirSync(dir)) if (isDocPath(`features/${f}`)) rels.add(`features/${f}`);
    }
  } catch { /* a symlinked or odd folder: list nothing from it */ }
  for (const r of db.selectDistinct({ path: requirementApprovals.path }).from(requirementApprovals).where(eq(requirementApprovals.projectId, p.id)).all()) rels.add(r.path);
  const docs = [...rels].sort((a, b) => (a === PRD_FILE ? -1 : b === PRD_FILE ? 1 : a.localeCompare(b))).map(rel => {
    try { return summarize(p, rel, readCurrent(p, rel)); } catch { return null; }
  }).filter(d => d !== null);
  return { dir: requirementsDir(p), docs };
}

export function getRequirement(p: ProjectLike, rel: string, version?: number): RequirementDoc {
  const cur = readCurrent(p, rel);
  const versions = approvalsOf(p.id, rel);
  const v = version !== undefined ? versions.find(x => x.version === version) : undefined;
  if (version !== undefined && !v) throw new RequirementsError(`no approved version ${version}`, 404);
  return {
    summary: summarize(p, rel, cur),
    content: cur?.content ?? null,
    versions: versions.map(x => ({ version: x.version, hash: x.hash, approvedAt: x.approvedAt })),
    viewing: v ? { version: v.version, content: v.content } : null,
  };
}

// The ids a revision of `rel` must keep (its file now and every approved version of it), and the ids
// every other document uses.
function idsAround(p: ProjectLike, rel: string, cur: { content: string } | null) {
  const kept = new Set<string>();
  if (cur) for (const i of parseRequirements(cur.content).items) kept.add(i.id);
  for (const a of approvalsOf(p.id, rel)) for (const id of JSON.parse(a.ids) as string[]) kept.add(id);
  const elsewhere = new Set<string>();
  for (const d of listRequirements(p).docs) if (d.path !== rel) for (const id of d.ids) elsewhere.add(id);
  return { kept, elsewhere };
}

export function saveRequirement(p: ProjectLike, rel: string, content: string, baseHash: string | null): RequirementDoc {
  const cur = readCurrent(p, rel);
  if ((cur?.hash ?? null) !== baseHash) {
    throw new RequirementsError(
      cur ? 'The file changed since you started editing (saved from an editor, or by git).' : 'The file was deleted since you started editing.',
      409, { content: cur?.content ?? null, hash: cur?.hash ?? null },
    );
  }
  if (cur && cur.content === content) return getRequirement(p, rel);
  const { kept, elsewhere } = idsAround(p, rel, cur);
  const errors = checkRevision(parseRequirements(content), kept, elsewhere);
  if (errors.length) throw new RequirementsError(errors.join(' '));

  // Write beside it and rename over it: an editor or git reading at the same moment never sees half a file.
  const abs = locate(p, rel, true);
  const tmp = resolve(abs, '..', `.${rel.split('/').pop()}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o644);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, abs);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return getRequirement(p, rel);
}

// Approve exactly the text that was reviewed. It must be the file as it is now, and differ from the
// latest approved version (approving the same text twice adds nothing).
export function approveRequirement(p: ProjectLike, rel: string, hash: string): RequirementDoc {
  const cur = readCurrent(p, rel);
  if (!cur) throw new RequirementsError('There is no file to approve.', 404);
  if (cur.hash !== hash) throw new RequirementsError('The file changed since you reviewed it; look at it again before approving.', 409, cur);
  const latest = approvalsOf(p.id, rel)[0];
  if (latest?.hash === hash) return getRequirement(p, rel);
  const parsed = parseRequirements(cur.content);
  const { kept, elsewhere } = idsAround(p, rel, null);
  const errors = checkRevision(parsed, kept, elsewhere);
  if (errors.length) throw new RequirementsError(errors.join(' '));
  db.insert(requirementApprovals).values({
    projectId: p.id, path: rel, version: (latest?.version ?? 0) + 1, hash, content: cur.content,
    ids: JSON.stringify(parsed.items.map(i => i.id)), approvedAt: new Date().toISOString(),
  }).run();
  return getRequirement(p, rel);
}

// For the hook: whether an absolute path the agent wants to edit falls inside a project's requirements.
// Compared case-insensitively (macOS folders are), and through symlinks: a link elsewhere that points
// in counts as inside.
export function isRequirementsPath(p: ProjectLike & { realPath?: string }, file: string): boolean {
  const roots = new Set([p.path, p.realPath ?? p.path]);
  try { roots.add(realpathSync(p.path)); } catch { /* gone */ }
  const dir = requirementsDir(p).toLowerCase();
  const targets = new Set<string>();
  for (const root of roots) {
    const abs = resolve(root, file);
    targets.add(abs);
    try { targets.add(realpathSync(abs)); } catch { /* new file */ }
    try { targets.add(join(realpathSync(dirname(abs)), basename(abs))); } catch { /* new folder */ }
  }
  for (const root of roots) {
    for (const t of targets) {
      const rel = relative(root, t).toLowerCase();
      if (rel === dir || rel.startsWith(dir + sep)) return true;
    }
  }
  return false;
}

// --- Context: a requirement or section attached to a message ------------------------------------

export type RequirementContextItem = { doc: string; ref: string; label: string; revision: string; text: string };
const CONTEXT_MAX = 8000;

// Read the attached part from the file as it is now, and say which revision that is: Discuss talks
// about the current text; what Build implements is a separate question (approved versions).
export function resolveRequirementRef(p: ProjectLike, doc: string, ref: string): RequirementContextItem {
  const cur = readCurrent(p, doc);
  if (!cur) throw new RequirementsError(`${doc} doesn't exist`, 404);
  const found = findRef(cur.content, ref);
  if (!found) throw new RequirementsError(`${ref} is not in ${doc} any more — refresh the PRD tab`, 404);
  const latest = approvalsOf(p.id, doc)[0];
  const revision = !latest ? 'draft, never approved'
    : latest.hash === cur.hash ? `approved v${latest.version}`
    : `draft: changed since approved v${latest.version}`;
  const text = found.text.length > CONTEXT_MAX ? `${found.text.slice(0, CONTEXT_MAX)}\n… (cut at ${CONTEXT_MAX} characters; read the file for the rest)` : found.text;
  return { doc, ref, label: found.label + (found.retired ? ' (retired)' : ''), revision, text };
}

// --- Proposals: edits the agent suggests, the user accepts or rejects ----------------------------

const proposalRow = (id: number) => db.select().from(requirementProposals).where(eq(requirementProposals.id, id)).get();

export function submitRequirementProposal(
  p: ProjectLike, chatId: number, runId: number, input: ProposeRequirementsEdit,
): { ok: true; id: number; created: boolean } | { ok: false; error: string } {
  if (!isDocPath(input.path)) return { ok: false, error: `"${input.path}" is not a requirements document: use "${PRD_FILE}" or "features/<slug>.md" (lower-case letters, digits, dashes)` };
  if ((input.edits === undefined) === (input.content === undefined)) return { ok: false, error: 'send either edits (to change an existing document) or content (to create one), not both' };
  let cur: { content: string; hash: string } | null;
  try { cur = readCurrent(p, input.path); } catch (e) { return { ok: false, error: (e as Error).message }; }
  let next: string;
  if (input.edits) {
    if (!cur) return { ok: false, error: `${input.path} doesn't exist yet; send its whole text as content to create it` };
    if (input.edits.length === 0) return { ok: false, error: 'no edits' };
    const r = applyEdits(cur.content, input.edits);
    if (!r.ok) return { ok: false, error: r.error };
    next = r.text;
  } else {
    if (cur) return { ok: false, error: `${input.path} exists; change it with edits (old_string/new_string against its current text) rather than replacing it whole` };
    next = input.content!;
  }
  if (cur && next === cur.content) return { ok: false, error: 'the edits change nothing' };
  const { kept, elsewhere } = idsAround(p, input.path, cur);
  const errors = checkRevision(parseRequirements(next), kept, elsewhere);
  if (errors.length) return { ok: false, error: errors.join(' ') };

  const at = new Date().toISOString();
  // A newer proposal from the same chat for the same document replaces the open one.
  db.update(requirementProposals).set({ status: 'superseded', decidedAt: at })
    .where(and(eq(requirementProposals.chatId, chatId), eq(requirementProposals.path, input.path), eq(requirementProposals.status, 'open'))).run();
  const row = db.insert(requirementProposals).values({
    projectId: p.id, chatId, runId, path: input.path, baseHash: cur?.hash ?? null, content: next,
    summary: input.summary.trim(), status: 'open', createdAt: at,
  }).returning().get();
  return { ok: true, id: row.id, created: !cur };
}

function toProposal(p: ProjectLike, row: typeof requirementProposals.$inferSelect): RequirementProposal {
  let cur: { content: string; hash: string } | null = null;
  try { cur = readCurrent(p, row.path); } catch { /* shown as no file */ }
  const chat = db.select({ title: chats.title }).from(chats).where(eq(chats.id, row.chatId)).get();
  return {
    id: row.id, path: row.path, chatId: row.chatId, chatTitle: chat?.title ?? `chat ${row.chatId}`, summary: row.summary,
    status: row.status, baseHash: row.baseHash, current: cur?.content ?? null, currentHash: cur?.hash ?? null,
    content: row.content, createdAt: row.createdAt, decidedAt: row.decidedAt,
  };
}

// The open ones, and the last few decided, newest first.
export function listRequirementProposals(p: ProjectLike): RequirementProposal[] {
  const rows = db.select().from(requirementProposals).where(eq(requirementProposals.projectId, p.id)).orderBy(desc(requirementProposals.id)).all();
  return [...rows.filter(r => r.status === 'open'), ...rows.filter(r => r.status !== 'open').slice(0, 10)].map(r => toProposal(p, r));
}

export function getRequirementProposal(p: ProjectLike, id: number): RequirementProposal {
  const row = proposalRow(id);
  if (!row || row.projectId !== p.id) throw new RequirementsError('no such proposal', 404);
  return toProposal(p, row);
}

// Accept: write the proposed text, but only over the file it was made against — if the document
// changed since (an edit here, in an editor, another proposal accepted), the agent proposes again.
export function decideRequirementProposal(p: ProjectLike, id: number, accept: boolean): RequirementProposal {
  const row = proposalRow(id);
  if (!row || row.projectId !== p.id) throw new RequirementsError('no such proposal', 404);
  if (row.status !== 'open') throw new RequirementsError(`this proposal was already ${row.status}`, 409);
  if (accept) {
    try {
      saveRequirement(p, row.path, row.content, row.baseHash);
    } catch (e) {
      if (e instanceof RequirementsError && e.status === 409) {
        throw new RequirementsError('The document changed since this was proposed. Reject it and ask for a new proposal against the current text.', 409);
      }
      throw e;
    }
  }
  db.update(requirementProposals).set({ status: accept ? 'accepted' : 'rejected', decidedAt: new Date().toISOString() })
    .where(eq(requirementProposals.id, id)).run();
  return getRequirementProposal(p, id);
}

// For the Discuss prompt: what became of this chat's recent proposals, which the agent can't see.
export function proposalStatusLine(chatId: number): string {
  const rows = db.select().from(requirementProposals).where(eq(requirementProposals.chatId, chatId)).orderBy(desc(requirementProposals.id)).limit(5).all();
  if (rows.length === 0) return '';
  return 'Your recent requirements proposals in this chat: ' + rows.map(r => `#${r.id} ${r.path} — ${r.status}`).join('; ') + '.';
}

// For the agent: what documents there are, their state and ids (it reads the text with Read).
export function requirementsOverview(p: ProjectLike) {
  const { dir, docs } = listRequirements(p);
  return {
    folder: dir,
    documents: docs.map(d => ({
      path: d.path, title: d.title, exists: d.hash !== null, state: d.state,
      approvedVersion: d.approved?.version ?? null, ids: d.ids,
    })),
  };
}
