// Plans, the stored part (PLAN.md §10): versions saved per chat, the baseline each was made against,
// whether it still holds, and approval. Nothing here writes map files or source files.
import { and, desc, eq } from 'drizzle-orm';
import {
  MAP_VIEWS, PlanBaseline, PlanBody, StoredMap,
  type MapViewId, type PlanFreshness, type PlanResponse, type PlanVersionInfo,
} from '../shared/contracts.ts';
import { coversFile, planCounts, planFiles, validatePlan, type Maps } from '../shared/plan.ts';
import { db, planVersions, plans } from './db.ts';
import { changedSinceRepos, mapsDir, readMap, repoBaselines } from './maps.ts';
import { latestCheck } from './verify.ts';
import * as feed from './feed.ts';

const now = () => new Date().toISOString();

type Project = { id: number; path: string; mapsRepo: string | null };

// The maps a version was made against; versions saved before snapshots existed fall back to now's.
export function versionMaps(row: { maps: string | null }, project: Project): Maps {
  if (!row.maps) return currentMaps(project);
  const raw = JSON.parse(row.maps) as Record<string, unknown>;
  return Object.fromEntries(MAP_VIEWS.map(v => [v.id, raw[v.id] ? StoredMap.safeParse(raw[v.id]).data ?? null : null]));
}

export function currentMaps(project: Project): Maps {
  const dir = mapsDir(project);
  return Object.fromEntries(MAP_VIEWS.map(v => [v.id, readMap(dir, v.id)]));
}

// ---------------------------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------------------------

export function captureBaseline(project: Project, maps: Maps): PlanBaseline {
  return {
    repos: repoBaselines(project.path),
    maps: Object.fromEntries(MAP_VIEWS.map(v => {
      const m = maps[v.id];
      return [v.id, m ? { generatedAt: m.generatedAt, commit: m.commit } : null];
    })),
    takenAt: now(),
  };
}

// Files whose content differs from what they were at the baseline, relative to the project.
// null = a commit the baseline names is gone, so what changed can't be known.
export const changedSinceBaseline = (project: Project, baseline: PlanBaseline): string[] | null =>
  changedSinceRepos(project.path, baseline.repos);

export function freshness(project: Project, body: PlanBody, baseline: PlanBaseline, maps: Maps): PlanFreshness {
  const changed = changedSinceBaseline(project, baseline);
  const files = planFiles(body, maps);
  const touched = (changed ?? []).filter(f => coversFile(files, f));
  const regenerated = MAP_VIEWS.map(v => v.id).filter(v =>
    body.changes[v] && (maps[v]?.generatedAt ?? null) !== (baseline.maps[v]?.generatedAt ?? null));
  const state: PlanFreshness['state'] =
    changed === null || touched.length ? 'stale'
    : regenerated.length ? 'map-regenerated'
    : changed.length ? 'elsewhere'
    : 'fresh';
  return { state, touched, changed: changed?.length ?? 0, maps: regenerated, baseMissing: changed === null };
}

// ---------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------

type VersionRow = typeof planVersions.$inferSelect;
const info = (v: VersionRow): PlanVersionInfo => ({
  id: v.id, version: v.version, source: v.source, createdAt: v.createdAt, approvedAt: v.approvedAt,
  counts: planCounts(PlanBody.parse(JSON.parse(v.body))),
});
const planFor = (chatId: number) => db.select().from(plans).where(eq(plans.chatId, chatId)).get();
const versionsOf = (planId: number) =>
  db.select().from(planVersions).where(eq(planVersions.planId, planId)).orderBy(desc(planVersions.version)).all();

function insertVersion(chatId: number, project: Project, body: PlanBody, source: VersionRow['source'], maps: Maps): VersionRow {
  let plan = planFor(chatId);
  if (!plan) {
    plan = db.insert(plans).values({ chatId, projectId: project.id, status: 'draft', createdAt: now() }).returning().get();
  } else if (plan.status === 'done' || plan.status === 'dropped') {
    // A new proposal after a finished or dropped plan starts a new one in the same chat.
    plan = db.update(plans).set({ status: 'draft', approvedVersionId: null }).where(eq(plans.id, plan.id)).returning().get();
  }
  const version = (versionsOf(plan.id)[0]?.version ?? 0) + 1;
  const warnings = body.steps.length ? [] : ['no build steps: Build will work from the changes alone'];
  return db.insert(planVersions).values({
    planId: plan.id, version, source, body: JSON.stringify(body), baseline: JSON.stringify(captureBaseline(project, maps)),
    warnings: JSON.stringify(warnings), maps: JSON.stringify(maps), createdAt: now(),
  }).returning().get();
}

export type Submitted = { ok: true; version: PlanVersionInfo } | { ok: false; errors: string[] };

// A proposal from the agent: checked against the current maps, saved as the next version.
export function submitProposal(chatId: number, project: Project, input: unknown): Submitted {
  const parsed = PlanBody.safeParse(input);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map(i => `${i.path.join('.') || 'plan'}: ${i.message}`) };
  const maps = currentMaps(project);
  const errors = validatePlan(parsed.data, maps);
  if (errors.length) return { ok: false, errors };
  return { ok: true, version: info(insertVersion(chatId, project, parsed.data, 'agent', maps)) };
}

const versionRow = (chatId: number, versionId: number) => {
  const plan = planFor(chatId);
  const v = plan && db.select().from(planVersions).where(and(eq(planVersions.id, versionId), eq(planVersions.planId, plan.id))).get();
  return plan && v ? { plan, v } : null;
};

// Same content, checked against today's maps and code, saved as a new version with a new baseline.
export function revalidate(chatId: number, project: Project, versionId: number): Submitted {
  const found = versionRow(chatId, versionId);
  if (!found) return { ok: false, errors: ['no such plan version in this chat'] };
  const body = PlanBody.parse(JSON.parse(found.v.body));
  const maps = currentMaps(project);
  const errors = validatePlan(body, maps);
  if (errors.length) return { ok: false, errors: ['it no longer fits the current maps; ask the agent to revise it', ...errors] };
  return { ok: true, version: info(insertVersion(chatId, project, body, 'revalidated', maps)) };
}

// Freeze one version as what Build implements. Only a version that still matches the code.
export function approve(chatId: number, project: Project, versionId: number): { ok: true } | { ok: false; error: string } {
  const found = versionRow(chatId, versionId);
  if (!found) return { ok: false, error: 'no such plan version in this chat' };
  if (found.plan.status === 'dropped' || found.plan.status === 'done') return { ok: false, error: `this plan is ${found.plan.status}` };
  const body = PlanBody.parse(JSON.parse(found.v.body));
  const f = freshness(project, body, PlanBaseline.parse(JSON.parse(found.v.baseline)), currentMaps(project));
  if (f.state === 'stale' || f.state === 'map-regenerated') {
    return { ok: false, error: 'the code or maps changed since this version was made; revalidate it (or ask for a revision) first' };
  }
  db.transaction(tx => {
    if (!found.v.approvedAt) tx.update(planVersions).set({ approvedAt: now() }).where(eq(planVersions.id, versionId)).run();
    tx.update(plans).set({ status: 'approved', approvedVersionId: versionId }).where(eq(plans.id, found.plan.id)).run();
  });
  return { ok: true };
}

// Ends the plan; every version is kept, and a new proposal starts a new one. Recorded in the chat.
export function drop(chatId: number, by: 'user' | 'agent', runId = 0): boolean {
  const plan = planFor(chatId);
  if (!plan || plan.status === 'done' || plan.status === 'dropped') return false;
  db.update(plans).set({ status: 'dropped' }).where(eq(plans.id, plan.id)).run();
  feed.append(chatId, { kind: 'plan-dropped', at: now(), runId, by });
  return true;
}

// The chat's plan as the agent should know it at the start of a turn: it can't see Flightdeck's UI.
export function planStatusLine(chatId: number): string {
  const plan = planFor(chatId);
  const rows = plan ? versionsOf(plan.id) : [];
  if (!plan || !rows[0]) return 'This chat has no plan yet.';
  const latest = rows[0];
  const title = PlanBody.parse(JSON.parse(latest.body)).title;
  const approved = rows.find(r => r.id === plan.approvedVersionId);
  switch (plan.status) {
    case 'dropped': return `This chat's plan ("${title}", latest v${latest.version}) was DROPPED: there is no plan in force. A new proposal starts a new one.`;
    case 'done': return `This chat's plan ("${title}") is done.`;
    case 'approved': return `This chat's plan: v${approved?.version} is APPROVED (what Build implements); the latest version is v${latest.version}${latest.id === approved?.id ? '' : ' (a draft, not approved)'}. Only the user approves, in Flightdeck.`;
    default: return `This chat's plan: v${latest.version} "${title}" is a DRAFT, not approved yet. Only the user approves, in Flightdeck.`;
  }
}

// The approved version Build turns implement, if the chat has one.
export function approvedVersion(chatId: number): { id: number; version: number; body: PlanBody } | null {
  const plan = planFor(chatId);
  if (!plan || plan.status !== 'approved' || plan.approvedVersionId === null) return null;
  const v = db.select().from(planVersions).where(eq(planVersions.id, plan.approvedVersionId)).get();
  return v ? { id: v.id, version: v.version, body: PlanBody.parse(JSON.parse(v.body)) } : null;
}

// A node that exists only in the chat's latest plan version (a planned box attached as context).
export function plannedNode(chatId: number, view: MapViewId, nodeId: string) {
  const plan = planFor(chatId);
  const latest = plan && versionsOf(plan.id)[0];
  if (!latest) return undefined;
  const n = PlanBody.parse(JSON.parse(latest.body)).changes[view]?.addNodes.find(a => a.id === nodeId);
  return n && { ...n, summary: `(planned in v${latest.version}, not built yet) ${n.summary}` };
}

export function planResponse(chatId: number, project: Project, versionId?: number): PlanResponse {
  const plan = planFor(chatId);
  if (!plan) return { plan: null, versions: [], version: null, check: null };
  const rows = versionsOf(plan.id);
  const v = versionId === undefined ? rows[0] : rows.find(r => r.id === versionId);
  const approvedRow = rows.find(r => r.id === plan.approvedVersionId);
  let version: PlanResponse['version'] = null;
  if (v) {
    const body = PlanBody.parse(JSON.parse(v.body));
    const baseline = PlanBaseline.parse(JSON.parse(v.baseline));
    version = { ...info(v), body, baseline, warnings: JSON.parse(v.warnings), freshness: freshness(project, body, baseline, currentMaps(project)) };
  }
  return {
    plan: { id: plan.id, status: plan.status, approvedVersionId: plan.approvedVersionId },
    versions: rows.map(info),
    version,
    check: approvedRow ? latestCheck(plan.id, approvedRow.id, approvedRow.version) : null,
  };
}

