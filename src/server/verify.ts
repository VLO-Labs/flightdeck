// Checking what was built against an approved plan version (PLAN.md §10, rule 5).
//
// Map ids only *align* the plan with the code: the regenerated maps are told to reuse the plan's ids
// for parts the code now has. A result rests on the code — files the plan names exist and changed in
// git since the version's baseline, the files of the aligned node changed, its arrows are cited in
// changed code. A node that exists only in a regenerated diagram is never Verified.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import {
  MAP_VIEWS, PlanBaseline, PlanBody,
  type CheckItem, type CheckResult, type MapViewId, type PlanBody as Body, type PlanCheck,
} from '../shared/contracts.ts';
import { cleanPath, coversFile, planFiles, type Maps } from '../shared/plan.ts';
import { db, planChecks, plans, planVersions, runs } from './db.ts';
import * as feed from './feed.ts';
import { jobFor, startGeneration } from './maps.ts';
import { changedSinceBaseline, currentMaps, versionMaps } from './plans.ts';

const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------------------------
// The assessment (pure)
// ---------------------------------------------------------------------------------------------

export type AssessInput = {
  body: Body;
  before: Maps; // the maps the check started from
  after: Maps; // regenerated, with the plan's ids as hints
  changed: string[]; // files changed since the version's baseline (git)
  exists: (path: string) => boolean;
};

const UNEXPECTED_FILES_MAX = 200;

export function assess({ body, before, after, changed, exists }: AssessInput): CheckItem[] {
  const items: CheckItem[] = [];
  const touching = (files: string[]) => changed.filter(f => coversFile(files, f));
  const list = (fs: string[], max = 5) => fs.slice(0, max).join(', ') + (fs.length > max ? ` +${fs.length - max} more` : '');
  const claimed: string[] = []; // files that planned parts account for

  for (const { id: view } of MAP_VIEWS) {
    const ch = body.changes[view];
    if (!ch) continue;
    const beforeById = new Map((before[view]?.nodes ?? []).map(n => [n.id, n]));
    const afterMap = after[view] ?? null;
    const afterById = new Map((afterMap?.nodes ?? []).map(n => [n.id, n]));
    const label = (id: string) => afterById.get(id)?.label ?? beforeById.get(id)?.label ?? ch.addNodes.find(n => n.id === id)?.label ?? id;
    const node = (change: CheckItem['change'], id: string, result: CheckResult, evidence: string[]) =>
      items.push({ view, kind: 'node', change, id, label: label(id), result, evidence });
    const mapLine = (present: boolean) => !afterMap
      ? 'map: not regenerated, so the diagram can\'t be aligned'
      : present ? 'map: the regenerated map has it (diagram only — not evidence by itself)' : 'map: not in the regenerated map';

    for (const n of ch.addNodes) {
      const planned = n.files.map(cleanPath).filter((f): f is string => f !== null);
      const present = planned.filter(exists);
      const hit = touching(planned);
      const inMap = afterById.get(n.id);
      const mapHit = inMap ? touching(inMap.files) : [];
      claimed.push(...planned, ...(inMap?.files ?? []));
      const ev: string[] = [];
      if (planned.length) ev.push(present.length ? `files: ${present.length} of ${planned.length} planned exist (${list(present)})` : `files: none of the planned files exist (${list(planned)})`);
      if (hit.length) ev.push(`git: changed since the baseline: ${list(hit)}`);
      if (mapHit.length && !hit.length) ev.push(`git: the files the map gives it changed: ${list(mapHit)}`);
      ev.push(mapLine(!!inMap));
      const code = hit.length > 0 || mapHit.length > 0;
      node('add', n.id, code && inMap ? 'verified' : !code && !inMap && present.length === 0 ? 'missing' : 'review', ev);
    }

    for (const c of ch.changeNodes) {
      const files = [...(c.files ?? []), ...(beforeById.get(c.id)?.files ?? [])];
      const hit = touching(files);
      const inMap = afterById.get(c.id);
      claimed.push(...files);
      const ev = [hit.length ? `git: its files changed: ${list(hit)}` : 'git: none of its files changed since the baseline', mapLine(!!inMap)];
      node('change', c.id, hit.length && inMap ? 'verified' : !hit.length ? 'missing' : 'review', ev);
    }

    for (const r of ch.removeNodes) {
      // Everything inside the removed node goes with it.
      const inside = (before[view]?.nodes ?? []).filter(n => {
        for (let p: string | null = n.id; p; p = beforeById.get(p)?.parent ?? null) if (p === r.id) return true;
        return false;
      });
      const files = inside.flatMap(n => n.files);
      const hit = touching(files);
      const left = files.filter(f => !f.endsWith('/') && exists(f));
      const inMap = afterById.has(r.id);
      claimed.push(...files);
      const ev = [
        hit.length ? `git: its files changed or were deleted: ${list(hit)}` : 'git: none of its files changed',
        left.length ? `files: still there: ${list(left)}` : 'files: its files are gone',
        mapLine(inMap),
      ];
      node('remove', r.id, afterMap && !inMap && hit.length ? 'verified' : inMap && !hit.length ? 'missing' : 'review', ev);
    }

    const edgeItem = (change: CheckItem['change'], from: string, to: string, result: CheckResult, evidence: string[]) =>
      items.push({ view, kind: 'edge', change, id: `${from}→${to}`, label: `${label(from)} → ${label(to)}`, result, evidence });
    const citedFile = (evidence?: string) => evidence?.replace(/:\d+$/, '');

    for (const e of ch.addEdges) {
      const drawn = afterMap?.edges.find(x => x.from === e.from && x.to === e.to);
      const file = citedFile(drawn?.evidence);
      if (!drawn) edgeItem('add', e.from, e.to, 'missing', [afterMap ? 'map: no such relationship in the regenerated map' : mapLine(false)]);
      else if (!file) edgeItem('add', e.from, e.to, 'review', ['map: drawn, but not cited in code (inferred)']);
      else {
        const changedThere = changed.includes(file);
        edgeItem('add', e.from, e.to, changedThere ? 'verified' : 'review', [
          `code: cited at ${drawn.evidence}`,
          changedThere ? 'git: that file changed since the baseline' : 'git: that file did not change since the baseline, so this may predate the plan',
        ]);
      }
    }

    for (const e of ch.removeEdges) {
      const old = before[view]?.edges.find(x => x.from === e.from && x.to === e.to && (e.label === undefined || x.label === e.label));
      const still = afterMap?.edges.some(x => x.from === e.from && x.to === e.to && (e.label === undefined || x.label === e.label));
      const file = citedFile(old?.evidence);
      if (still) edgeItem('remove', e.from, e.to, 'missing', ['map: still in the regenerated map']);
      else if (!afterMap) edgeItem('remove', e.from, e.to, 'review', [mapLine(false)]);
      else if (file && changed.includes(file)) edgeItem('remove', e.from, e.to, 'verified', [`code: the call was at ${old!.evidence}; that file changed`, 'map: gone from the regenerated map']);
      else edgeItem('remove', e.from, e.to, 'review', ['map: gone from the regenerated map', file ? `git: ${file}, where it was cited, did not change` : 'code: it was never cited in code']);
    }

    // New parts in the regenerated map that the plan didn't have, whose files changed.
    const planned = new Set(ch.addNodes.map(n => n.id));
    for (const n of afterMap?.nodes ?? []) {
      if (beforeById.has(n.id) || planned.has(n.id)) continue;
      const hit = touching(n.files);
      if (hit.length) node('none', n.id, 'unexpected', [`map: new in the regenerated map, not in the plan`, `git: its files changed: ${list(hit)}`]);
    }
  }

  // Changed files no planned part accounts for.
  const covered = [...new Set([...claimed, ...planFiles(body, before)])];
  const loose = changed.filter(f => !f.startsWith('.flightdeck/') && !coversFile(covered, f));
  for (const f of loose.slice(0, UNEXPECTED_FILES_MAX)) {
    items.push({ view: null, kind: 'file', change: 'none', id: f, label: f, result: 'unexpected', evidence: ['git: changed since the baseline; no planned part covers it'] });
  }
  if (loose.length > UNEXPECTED_FILES_MAX) {
    items.push({ view: null, kind: 'file', change: 'none', id: '…', label: `+${loose.length - UNEXPECTED_FILES_MAX} more files`, result: 'unexpected', evidence: [] });
  }
  return items;
}

export const countResults = (items: CheckItem[]) => {
  const counts: Record<CheckResult, number> = { verified: 0, missing: 0, unexpected: 0, review: 0 };
  for (const i of items) counts[i.result]++;
  return counts;
};

// What the regenerated maps are told: reuse the old ids for parts that still exist, and the plan's
// ids for parts that now exist in code. Only alignment — the generator still maps only what's there.
export function generationHints(body: Body, view: MapViewId, before: Maps): string {
  const ch = body.changes[view];
  const old = before[view]?.nodes ?? [];
  const lines = [
    'ID ALIGNMENT. Flightdeck compares this map with an earlier one and with a plan, by id. These ids',
    'only tell you what to CALL a part; include a part only if it exists in the code as it is now.',
  ];
  if (old.length) lines.push('', 'Ids from the previous map — reuse the id for a part that still exists:', ...old.map(n => `- ${n.id}: ${n.label} (${n.kind})`));
  if (ch?.addNodes.length) lines.push('', 'Ids a plan gave to new parts — use the id if the code now has that part:', ...ch.addNodes.map(n => `- ${n.id}: ${n.label} (${n.kind}) — ${n.summary}`));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Test runs seen in the Build turns that implemented the version
// ---------------------------------------------------------------------------------------------

const TEST_COMMAND = /\b(npm (run )?test|pnpm test|yarn test|vitest|jest|pest|phpunit|php artisan test|composer test|pytest|go test|cargo test|rspec|mix test)\b/;

export function testRuns(chatId: number, versionId: number): PlanCheck['tests'] {
  const runIds = new Set(db.select({ id: runs.id }).from(runs).where(and(eq(runs.chatId, chatId), eq(runs.planVersionId, versionId))).all().map(r => r.id));
  const calls = new Map<string, { command: string; at: string }>();
  const out: PlanCheck['tests'] = [];
  for (const it of feed.replay(chatId)) {
    if (it.kind !== 'claude' || !runIds.has(it.runId)) continue;
    const msg = (it.event as { message?: { content?: unknown } }).message;
    const content = Array.isArray(msg?.content) ? msg.content as Record<string, unknown>[] : [];
    for (const c of content) {
      if (c.type === 'tool_use' && c.name === 'Bash') {
        const command = String((c.input as { command?: unknown })?.command ?? '');
        if (TEST_COMMAND.test(command)) calls.set(String(c.id), { command, at: it.at });
      } else if (c.type === 'tool_result' && calls.has(String(c.tool_use_id))) {
        out.push({ ...calls.get(String(c.tool_use_id))!, ok: c.is_error !== true });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Running a check: regenerate the plan's views (one at a time, with the hints), then assess.
// ---------------------------------------------------------------------------------------------

type Project = { id: number; path: string; discussModel: string; mapsRepo: string | null };
const checksRunning = new Map<number, { progress: string }>(); // by check id

export function startCheck(chatId: number, project: Project): { ok: true; checkId: number } | { ok: false; error: string } {
  const plan = db.select().from(plans).where(eq(plans.chatId, chatId)).get();
  if (!plan || plan.status !== 'approved' || plan.approvedVersionId === null) return { ok: false, error: 'approve a plan version first' };
  if ([...checksRunning.keys()].some(id => db.select().from(planChecks).where(eq(planChecks.id, id)).get()?.planId === plan.id)) {
    return { ok: false, error: 'a check is already running' };
  }
  if (jobFor(project.id)?.status === 'running') return { ok: false, error: 'a map is being generated for this project; try when it finishes' };
  const v = db.select().from(planVersions).where(eq(planVersions.id, plan.approvedVersionId)).get()!;
  const body = PlanBody.parse(JSON.parse(v.body));
  const baseline = PlanBaseline.parse(JSON.parse(v.baseline));
  const row = db.insert(planChecks).values({ planId: plan.id, versionId: v.id, status: 'running', result: '{}', createdAt: now() }).returning().get();
  const state = { progress: 'Starting…' };
  checksRunning.set(row.id, state);

  const finish = (status: 'done' | 'failed', result: Omit<PlanCheck, 'id' | 'versionId' | 'version' | 'createdAt' | 'status' | 'progress'>) => {
    checksRunning.delete(row.id);
    db.update(planChecks).set({ status, result: JSON.stringify(result) }).where(eq(planChecks.id, row.id)).run();
    feed.append(chatId, {
      kind: 'check', at: now(), runId: 0, checkId: row.id, version: v.version, versionId: v.id, counts: result.counts,
      ...(result.error ? { failed: result.error } : {}),
    });
  };

  void (async () => {
    try {
      // The maps as they were when this version was made, not the files now: an earlier check (or a
      // manual refresh) may already have regenerated them with the built parts in.
      const before = versionMaps(v, project);
      for (const { id: view } of MAP_VIEWS.filter(m => body.changes[m.id])) {
        state.progress = `Regenerating the ${view} map…`;
        const started = startGeneration(project, view, generationHints(body, view, before));
        if (!started.ok) throw new Error(started.error);
        for (;;) {
          await new Promise(r => setTimeout(r, 2000));
          const job = jobFor(project.id);
          if (!job || job.status === 'running') continue;
          if (job.status !== 'done') throw new Error(`regenerating the ${view} map ${job.status}${job.error ? `: ${job.error}` : ''}`);
          break;
        }
      }
      state.progress = 'Comparing with the code…';
      const changed = changedSinceBaseline(project, baseline);
      if (changed === null) throw new Error('the commit the plan was approved on is gone (rebase or reset), so what changed since can\'t be known');
      const items = assess({ body, before, after: currentMaps(project), changed, exists: f => existsSync(join(project.path, f)) });
      finish('done', { items, tests: testRuns(chatId, v.id), counts: countResults(items), error: null });
    } catch (e) {
      finish('failed', { items: [], tests: [], counts: countResults([]), error: (e as Error).message });
    }
  })();
  return { ok: true, checkId: row.id };
}

// The latest check of a version, finished or running.
export function latestCheck(planId: number, versionId: number, version: number): PlanCheck | null {
  const row = db.select().from(planChecks)
    .where(and(eq(planChecks.planId, planId), eq(planChecks.versionId, versionId))).orderBy(desc(planChecks.id)).get();
  if (!row) return null;
  const running = checksRunning.get(row.id);
  const r = JSON.parse(row.result) as Partial<PlanCheck>;
  return {
    id: row.id, versionId, version, createdAt: row.createdAt,
    status: running ? 'running' : row.status === 'running' ? 'failed' : row.status,
    progress: running?.progress ?? '', error: row.status === 'running' && !running ? 'Flightdeck restarted during the check' : r.error ?? null,
    items: r.items ?? [], tests: r.tests ?? [], counts: r.counts ?? countResults([]),
  };
}
