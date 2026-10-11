// Pure graph helpers behind the map canvas (no React, no CSS), so they can be tested directly.
import type { MapEdge, MapNode, StoredMap } from '../shared/contracts.ts';

export type LiftedEdge = { from: string; to: string; labels: string[]; twoWay: boolean };

// Edges can join nodes at any depth; show each one between the visible ancestors of its ends.
// A→B and B→A become one two-way edge: drawn separately, the reverse one loops around the layout.
export function liftEdges(nodes: MapNode[], edges: MapEdge[], level: string | null): LiftedEdge[] {
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
    const reverse = out.get(`${to}→${from}`);
    if (reverse) {
      reverse.twoWay = true;
      if (e.label && !reverse.labels.includes(e.label)) reverse.labels.push(e.label);
      continue;
    }
    const key = `${from}→${to}`;
    const cur = out.get(key) ?? { from, to, labels: [], twoWay: false };
    if (e.label && !cur.labels.includes(e.label)) cur.labels.push(e.label);
    out.set(key, cur);
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
