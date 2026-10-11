// Plans, the pure part (PLAN.md §10): checking a proposal against the current maps, and laying it
// over a map for drawing. Shared by the server (validation) and the web (the overlay).
import { MAP_VIEWS, type MapEdge, type MapNode, type MapViewId, type PlanBody, type PlanViewChange, type StoredMap } from './contracts.ts';

export type PlanStatus = 'added' | 'changed' | 'removed';
export type PlannedNode = MapNode & { status?: PlanStatus; why?: string; before?: MapNode };
export type PlannedEdge = MapEdge & { status?: PlanStatus; why?: string };
export type PlannedMap = { nodes: PlannedNode[]; edges: PlannedEdge[] };

export type Maps = Partial<Record<MapViewId, StoredMap | null>>;

const views = (body: PlanBody) =>
  MAP_VIEWS.map(v => v.id).filter(v => body.changes[v]).map(v => [v, body.changes[v]!] as const);

const edgeMatches = (e: MapEdge, r: { from: string; to: string; label?: string }) =>
  e.from === r.from && e.to === r.to && (r.label === undefined || e.label === r.label);

// Repo-relative, inside the project: no absolute paths, no `..`.
export function cleanPath(p: string): string | null {
  const c = p.trim().replace(/^\.\//, '');
  if (!c || c.startsWith('/') || c.split('/').includes('..') || /^[a-zA-Z]:/.test(c)) return null;
  return c;
}

// Problems that reject a proposal; the agent gets them back and resubmits.
export function validatePlan(body: PlanBody, maps: Maps): string[] {
  const errors: string[] = [];
  const err = (view: string, msg: string) => errors.push(`${view}: ${msg}`);
  let total = 0;

  for (const [view, ch] of views(body)) {
    const map = maps[view] ?? null;
    const existing = new Map((map?.nodes ?? []).map(n => [n.id, n]));
    const added = new Map<string, (typeof ch.addNodes)[number]>();
    total += ch.addNodes.length + ch.changeNodes.length + ch.removeNodes.length + ch.addEdges.length + ch.removeEdges.length;

    for (const n of ch.addNodes) {
      if (existing.has(n.id)) err(view, `new node "${n.id}" uses the id of an existing node; pick a new id, or put it under changeNodes`);
      else if (added.has(n.id)) err(view, `node "${n.id}" is added twice`);
      added.set(n.id, n);
      for (const f of n.files) if (cleanPath(f) === null) err(view, `node "${n.id}" has file "${f}": paths must be relative to the project, without ".."`);
    }
    const removed = new Set<string>();
    for (const r of ch.removeNodes) {
      if (!existing.has(r.id)) err(view, `can't remove "${r.id}": no such node in the current map`);
      removed.add(r.id);
    }
    // Removing a node removes what's inside it.
    const gone = (id: string): boolean => {
      for (let n = existing.get(id); n; n = n.parent ? existing.get(n.parent) : undefined) if (removed.has(n.id)) return true;
      return false;
    };
    const changed = new Set<string>();
    for (const c of ch.changeNodes) {
      if (!existing.has(c.id)) err(view, `can't change "${c.id}": no such node in the current map${added.has(c.id) ? ' (it is one of the new nodes; describe it there)' : ''}`);
      else if (gone(c.id)) err(view, `"${c.id}" is both changed and removed`);
      if (changed.has(c.id)) err(view, `"${c.id}" is changed twice; merge the changes`);
      changed.add(c.id);
      for (const f of c.files ?? []) if (cleanPath(f) === null) err(view, `node "${c.id}" has file "${f}": paths must be relative to the project, without ".."`);
    }
    for (const n of added.values()) {
      if (n.parent === null) continue;
      if (existing.has(n.parent) ? gone(n.parent) : !added.has(n.parent)) {
        err(view, `new node "${n.id}" has parent "${n.parent}", which ${existing.has(n.parent) ? 'is being removed' : "doesn't exist"}`);
        continue;
      }
      const seen = new Set<string>();
      for (let p: string | null = n.id; p !== null && added.has(p); p = added.get(p)!.parent) {
        if (seen.has(p)) { err(view, `new nodes form a parent cycle at "${n.id}"`); break; }
        seen.add(p);
      }
    }
    const alive = (id: string) => added.has(id) || (existing.has(id) && !gone(id));
    for (const e of ch.addEdges) {
      if (!alive(e.from) || !alive(e.to)) err(view, `edge ${e.from} → ${e.to} joins a node that doesn't exist or is removed`);
      else if (e.from === e.to) err(view, `edge ${e.from} → ${e.to} joins a node to itself`);
    }
    for (const r of ch.removeEdges) {
      const hits = (map?.edges ?? []).filter(e => edgeMatches(e, r));
      if (hits.length === 0) err(view, `can't remove edge ${r.from} → ${r.to}${r.label ? ` "${r.label}"` : ''}: not in the current map`);
      else if (hits.length > 1) err(view, `edge ${r.from} → ${r.to} matches ${hits.length} edges; give its label`);
    }
  }
  if (total === 0) errors.push('the plan changes nothing: add, change or remove at least one node or edge');

  for (const s of body.steps) {
    for (const ref of s.nodes) {
      const [view, id] = ref.split(':') as [MapViewId, string | undefined];
      const ch = body.changes[view];
      const known = id !== undefined && (maps[view]?.nodes.some(n => n.id === id) || ch?.addNodes.some(n => n.id === id));
      if (!known) errors.push(`step "${s.text.slice(0, 40)}" names "${ref}": use "view:id" of a node in the plan or the map`);
    }
  }
  return errors;
}

// The map with the plan laid over it. Unchanged parts keep their place; removed ones stay in, marked,
// so the layout doesn't jump; added ones join their parents.
export function applyPlan(map: StoredMap | null, ch: PlanViewChange | undefined): PlannedMap {
  const nodes: PlannedNode[] = (map?.nodes ?? []).map(n => ({ ...n }));
  const edges: PlannedEdge[] = (map?.edges ?? []).map(e => ({ ...e }));
  if (!ch) return { nodes, edges };
  const byId = new Map(nodes.map(n => [n.id, n]));

  const removedIds = new Set(ch.removeNodes.map(r => r.id));
  for (const n of nodes) {
    for (let p: PlannedNode | undefined = n; p; p = p.parent ? byId.get(p.parent) : undefined) {
      if (!removedIds.has(p.id)) continue;
      n.status = 'removed';
      n.why = ch.removeNodes.find(r => r.id === p.id)!.why;
      break;
    }
  }
  for (const c of ch.changeNodes) {
    const n = byId.get(c.id);
    if (!n || n.status) continue;
    const { id: _id, why, ...fields } = c;
    Object.assign(n, { before: { ...n }, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)), status: 'changed', why });
  }
  for (const a of ch.addNodes) {
    const { why, ...n } = a;
    // After a build the regenerated map may already have it (same id, by the check's alignment):
    // mark that one rather than drawing it twice.
    const built = byId.get(n.id);
    if (built) { Object.assign(built, { status: 'added', why }); continue; }
    const node: PlannedNode = { ...n, status: 'added', why };
    nodes.push(node);
    byId.set(node.id, node);
  }

  const removedNode = (id: string) => byId.get(id)?.status === 'removed';
  for (const e of edges) {
    const r = ch.removeEdges.find(r => edgeMatches(e, r));
    if (r) Object.assign(e, { status: 'removed', why: r.why });
    else if (removedNode(e.from) || removedNode(e.to)) Object.assign(e, { status: 'removed', why: 'one end is removed' });
  }
  for (const a of ch.addEdges) {
    const { why, ...e } = a;
    const built = edges.find(x => x.from === e.from && x.to === e.to && !x.status);
    if (built) Object.assign(built, { status: 'added', why });
    else edges.push({ ...e, status: 'added', why });
  }
  return { nodes, edges };
}

// How much a plan changes, for its version list and feed line.
export function planCounts(body: PlanBody): { added: number; changed: number; removed: number } {
  let added = 0, changed = 0, removed = 0;
  for (const [, ch] of views(body)) {
    added += ch.addNodes.length + ch.addEdges.length;
    changed += ch.changeNodes.length;
    removed += ch.removeNodes.length + ch.removeEdges.length;
  }
  return { added, changed, removed };
}

// Every file the plan works in: what its new and changed nodes name, and what the nodes it changes or
// removes cover today (with everything inside removed nodes). Directories end in '/'.
export function planFiles(body: PlanBody, maps: Maps): string[] {
  const files = new Set<string>();
  for (const [view, ch] of views(body)) {
    const nodes = maps[view]?.nodes ?? [];
    const byId = new Map(nodes.map(n => [n.id, n]));
    const within = (id: string, root: string) => {
      for (let n = byId.get(id); n; n = n.parent ? byId.get(n.parent) : undefined) if (n.id === root) return true;
      return false;
    };
    const add = (fs: string[]) => fs.forEach(f => { const c = cleanPath(f); if (c) files.add(c); });
    for (const n of ch.addNodes) add(n.files);
    for (const c of ch.changeNodes) { add(c.files ?? []); add(byId.get(c.id)?.files ?? []); }
    for (const r of ch.removeNodes) for (const n of nodes) if (within(n.id, r.id)) add(n.files);
  }
  return [...files];
}

export const coversFile = (files: string[], path: string) =>
  files.some(f => (f.endsWith('/') ? path.startsWith(f) : path === f || path.startsWith(f + '/')));

// The approved plan as Build turns read it: what to add, change and remove per view, with the
// planned files, then the steps. Ids stay in, so the agent can say which part it's working on.
export function planAsText(body: PlanBody, version: number, maps: Maps): string {
  const out = [`Approved plan v${version}: ${body.title}`, '', body.summary.trim()];
  for (const [view, ch] of views(body)) {
    const label = (id: string) => maps[view]?.nodes.find(n => n.id === id)?.label ?? ch.addNodes.find(n => n.id === id)?.label ?? id;
    out.push('', `## ${view}`);
    for (const n of ch.addNodes) {
      out.push(`- ADD ${n.kind} "${n.label}" [${n.id}]${n.parent ? ` inside "${label(n.parent)}"` : ''}: ${n.summary} — ${n.why}`);
      if (n.files.length) out.push(`  files: ${n.files.join(', ')}`);
      if (n.fields.length) out.push(`  fields: ${n.fields.map(f => `${f.name} ${f.type}${f.note ? ` (${f.note})` : ''}`).join('; ')}`);
    }
    for (const c of ch.changeNodes) {
      const what = (['label', 'kind', 'summary'] as const).filter(k => c[k] !== undefined).map(k => `${k} → "${c[k]}"`);
      if (c.files) what.push(`files → ${c.files.join(', ')}`);
      if (c.fields) what.push(`fields → ${c.fields.map(f => `${f.name} ${f.type}`).join('; ')}`);
      out.push(`- CHANGE "${label(c.id)}" [${c.id}]: ${what.join(', ') || 'see why'} — ${c.why}`);
    }
    for (const r of ch.removeNodes) out.push(`- REMOVE "${label(r.id)}" [${r.id}] and everything inside it — ${r.why}`);
    for (const e of ch.addEdges) out.push(`- CONNECT "${label(e.from)}" → "${label(e.to)}"${e.label ? ` (${e.label})` : ''} — ${e.why}`);
    for (const e of ch.removeEdges) out.push(`- DISCONNECT "${label(e.from)}" → "${label(e.to)}"${e.label ? ` (${e.label})` : ''} — ${e.why}`);
  }
  if (body.steps.length) {
    out.push('', '## Steps');
    body.steps.forEach((s, i) => out.push(`${i + 1}. ${s.text}`));
  }
  if (body.questions.length) {
    out.push('', '## Questions that were open when it was approved (check the conversation for answers)');
    for (const q of body.questions) out.push(`- ${q}`);
  }
  return out.join('\n');
}
