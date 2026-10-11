// Pure graph helpers behind the map canvas (no React, no CSS), so they can be tested directly.
import type { MapNode, StoredMap } from '../shared/contracts.ts';
import type { PlannedEdge, PlanStatus } from '../shared/plan.ts';

export type Heat = 'read' | 'edit';

// labels: what flows, for drawing; parts: each label with the code that shows it, when cited.
// status: on a plan, whether the relationship is added or removed (absent = unchanged).
export type EdgePart = { label: string; evidence?: string; status?: PlanStatus };
export type LiftedEdge = { from: string; to: string; labels: string[]; parts: EdgePart[]; twoWay: boolean; status?: PlanStatus };

// Edges can join nodes at any depth; show each one between the visible ancestors of its ends.
// A→B and B→A become one two-way edge: drawn separately, the reverse one loops around the layout.
export function liftEdges(nodes: MapNode[], edges: PlannedEdge[], level: string | null): LiftedEdge[] {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const visibleAncestor = (id: string): string | undefined => {
    for (let n = byId.get(id); n; n = n.parent ? byId.get(n.parent) : undefined) if (n.parent === level) return n.id;
    return undefined;
  };
  const out = new Map<string, LiftedEdge>();
  for (const e of edges) {
    const from = visibleAncestor(e.from);
    const to = visibleAncestor(e.to);
    if (!from || !to || from === to) continue;
    const add = (le: LiftedEdge) => {
      if (e.label && !le.labels.includes(e.label)) le.labels.push(e.label);
      if (!le.parts.some(p => p.label === e.label && p.evidence === e.evidence)) le.parts.push({ label: e.label, evidence: e.evidence, ...(e.status ? { status: e.status } : {}) });
    };
    const reverse = out.get(`${to}→${from}`);
    if (reverse) {
      reverse.twoWay = true;
      add(reverse);
      continue;
    }
    const key = `${from}→${to}`;
    const cur = out.get(key) ?? { from, to, labels: [], parts: [], twoWay: false };
    add(cur);
    out.set(key, cur);
  }
  // A drawn edge is added or removed when all it stands for is; a mix of the two reads as changed.
  for (const le of out.values()) {
    const st = new Set(le.parts.map(p => p.status));
    const only = st.size === 1 ? le.parts[0]!.status : undefined;
    if (only) le.status = only;
    else if (st.size > 1) le.status = 'changed';
  }
  return [...out.values()];
}

// The most specific nodes whose files cover a repo-relative path (a directory covers everything under it).
export function nodesForFile(map: StoredMap, rel: string): string[] {
  const covering = map.nodes.filter(n => n.files.some(f => (f.endsWith('/') ? rel.startsWith(f) : rel === f)));
  const ids = new Set(covering.map(n => n.id));
  // Drop a node when one of its descendants also covers the file.
  const byId = new Map(map.nodes.map(n => [n.id, n]));
  const hasCoveringDescendant = (id: string) =>
    covering.some(c => { for (let p = c.parent; p; p = byId.get(p)?.parent ?? null) if (p === id) return true; return false; });
  return [...ids].filter(id => !hasCoveringDescendant(id));
}
