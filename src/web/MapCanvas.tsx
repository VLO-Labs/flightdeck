// The diagram itself, shared by the Map screen and the map pane inside a chat: auto-layout of
// one level of a map, drill-down by double-click, and markers (stale, selected, context, heat).
import { useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, BaseEdge, Controls, Handle, MarkerType, Position, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkExtendedEdge } from 'elkjs/lib/elk-api.js';
import type { MapEdge, MapNode, MapViewId, StoredMap } from '../shared/contracts.ts';

const elk = new ELK();
const W = 240;
const heightOf = (n: MapNode) => 78 + Math.min(n.fields.length, 12) * 17;

export type Heat = 'read' | 'edit';

type CardData = { node: MapNode; stale: boolean; childCount: number; selected: boolean; inContext: boolean; heat?: Heat };

function NodeCard({ data }: NodeProps<Node<CardData>>) {
  const { node, stale, childCount, selected, inContext, heat } = data;
  return (
    <div
      className={`map-node kind-${node.kind} ${stale ? 'stale' : ''} ${selected ? 'selected' : ''} ${inContext ? 'in-context' : ''} ${heat ? `heat-${heat}` : ''}`}
      style={{ width: W }}
    >
      <Handle type="target" position={Position.Left} />
      <div className="map-node-head">
        <span className="map-node-label">{node.label}</span>
        <span className="map-node-kind">{node.kind}</span>
      </div>
      <div className="map-node-summary">{node.summary}</div>
      {node.fields.length > 0 && (
        <div className="map-node-fields">
          {node.fields.slice(0, 12).map(f => (
            <div key={f.name}><span>{f.name}</span> <span className="muted">{f.type}{f.note ? ` · ${f.note}` : ''}</span></div>
          ))}
          {node.fields.length > 12 && <div className="muted">+{node.fields.length - 12} more</div>}
        </div>
      )}
      <div className="map-node-foot">
        {childCount > 0 && <span>▸ {childCount} inside</span>}
        {heat === 'edit' && <span className="heat-tag edit">edited</span>}
        {heat === 'read' && <span className="heat-tag read">read</span>}
        {stale && !heat && <span className="stale-tag">changed</span>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { card: NodeCard };

// Edges are drawn along the route ELK computed (right angles around the cards), not React Flow's own
// curves, which know nothing about the other cards. The label sits in the space ELK reserved for it.
type Point = { x: number; y: number };
type RouteData = { points: Point[]; label?: string; labelAt?: Point; showLabel: boolean };

function RouteEdge({ id, data, markerStart, markerEnd, style }: EdgeProps<Edge<RouteData>>) {
  const pts = data?.points ?? [];
  if (pts.length < 2) return null;
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
  const show = data!.showLabel && data!.label && data!.labelAt;
  return (
    <BaseEdge
      id={id} path={path} markerStart={markerStart} markerEnd={markerEnd} style={style}
      label={show ? data!.label : undefined} labelX={data!.labelAt?.x} labelY={data!.labelAt?.y}
      labelBgPadding={[4, 2]} labelBgBorderRadius={3}
      labelStyle={{ fill: 'var(--text)', fontSize: 11 }} labelBgStyle={{ fill: 'var(--panel)' }}
    />
  );
}
const edgeTypes = { route: RouteEdge };

function longestMidpoint(points: Point[]): Point | undefined {
  let best: Point | undefined;
  let bestLen = -1;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const len = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    if (len > bestLen) { bestLen = len; best = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  }
  return best;
}
// Up to this many edges, every label shows; past it, labels show for the hovered edge and the
// selected card's edges only, or the map turns into a wall of text.
const ALWAYS_LABEL = 8;

// Edges can join nodes at any depth; show each one between the visible ancestors of its ends.
function liftEdges(nodes: MapNode[], edges: MapEdge[], level: string | null) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const visibleAncestor = (id: string): string | undefined => {
    for (let n = byId.get(id); n; n = n.parent ? byId.get(n.parent) : undefined) if (n.parent === level) return n.id;
    return undefined;
  };
  // A→B and B→A become one two-way edge: drawn separately, the reverse one loops around the layout.
  const out = new Map<string, { from: string; to: string; labels: string[]; twoWay: boolean }>();
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

export function MapCanvas({
  map, view, stale, path, onPath, selected, onSelect, inContext, heat,
}: {
  map: StoredMap;
  view: MapViewId;
  stale: Set<string>;
  path: string[];
  onPath: (p: string[]) => void;
  selected?: string | null;
  onSelect: (id: string | null) => void;
  inContext?: Set<string>;
  heat?: Map<string, Heat>; // by node id, at any depth
}) {
  const [layout, setLayout] = useState<{ nodes: Node<CardData>[]; edges: Edge<RouteData>[] } | null>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const level = path.at(-1) ?? null;
  // A double-click also fires two clicks; hold each click briefly so a double-click is only a drill.
  const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(clickTimer.current), []);

  // A visible node is as hot as its hottest descendant, so activity deep inside shows at the top.
  const visibleHeat = useMemo(() => {
    const out = new Map<string, Heat>();
    if (!heat) return out;
    const byId = new Map(map.nodes.map(n => [n.id, n]));
    for (const [id, h] of heat) {
      for (let n = byId.get(id); n; n = n.parent ? byId.get(n.parent) : undefined) {
        if (n.parent === level) {
          if (out.get(n.id) !== 'edit') out.set(n.id, h);
          break;
        }
      }
    }
    return out;
  }, [heat, map, level]);

  const contextKey = [...(inContext ?? [])].join(',');
  const heatKey = [...visibleHeat].map(([k, v]) => `${k}:${v}`).join(',');

  // A new level or view mounts a fresh canvas; clear the old layout so it fits the new nodes, not the old.
  useEffect(() => setLayout(null), [level, view, map]);

  useEffect(() => {
    const visible = map.nodes.filter(n => n.parent === level);
    const lifted = liftEdges(map.nodes, map.edges, level);
    const childCount = (id: string) => map.nodes.filter(n => n.parent === id).length;
    let cancelled = false;
    elk.layout({
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': view === 'flows' && level !== null ? 'DOWN' : 'RIGHT',
        'elk.spacing.nodeNode': '40',
        'elk.layered.spacing.nodeNodeBetweenLayers': '90',
        'elk.edgeRouting': 'ORTHOGONAL',
        'elk.spacing.edgeEdge': '14',
        'elk.spacing.edgeNode': '24',
        'elk.layered.spacing.edgeNodeBetweenLayers': '24',
        'elk.layered.spacing.edgeEdgeBetweenLayers': '12',
      },
      children: visible.map(n => ({ id: n.id, width: W, height: heightOf(n) })),
      // Labels get no reserved space: on a busy map that stretches the layout far wider than the
      // screen. They're shown on demand instead, on the line's longest straight stretch.
      edges: lifted.map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] })),
    }).then(g => {
      if (cancelled) return;
      const pos = new Map((g.children ?? []).map(c => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
      const routes = new Map(((g.edges ?? []) as ElkExtendedEdge[]).map(e => {
        const s = e.sections?.[0];
        const points = s ? [s.startPoint, ...(s.bendPoints ?? []), s.endPoint] : [];
        return [e.id, { points, labelAt: longestMidpoint(points) }];
      }));
      setLayout({
        nodes: visible.map(n => ({
          id: n.id, type: 'card', position: pos.get(n.id) ?? { x: 0, y: 0 },
          data: {
            node: n, stale: stale.has(n.id), childCount: childCount(n.id), selected: selected === n.id,
            inContext: inContext?.has(n.id) ?? false, heat: visibleHeat.get(n.id),
          },
        })),
        edges: lifted.map((e, i) => ({
          id: `e${i}`, source: e.from, target: e.to, type: 'route',
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
          markerStart: e.twoWay ? { type: MarkerType.ArrowClosed, width: 16, height: 16 } : undefined,
          data: { ...routes.get(`e${i}`)!, label: edgeLabel(e.labels), showLabel: lifted.length <= ALWAYS_LABEL },
          animated: visibleHeat.has(e.from) && visibleHeat.has(e.to),
        })),
      });
    });
    return () => { cancelled = true; };
    // inContext/visibleHeat are tracked through their keys so a new Set each render doesn't relayout.
  }, [map, level, view, stale, selected, contextKey, heatKey]);

  if (!layout) return null;
  // Busy maps: label only the hovered edge and the edges touching the selected card.
  const edges = layout.edges.length <= ALWAYS_LABEL ? layout.edges : layout.edges.map(e => {
    const show = e.id === hoverEdge || (selected != null && (e.source === selected || e.target === selected));
    return show ? { ...e, data: { ...e.data!, showLabel: true }, zIndex: 1 } : e;
  });
  return (
    <ReactFlow
      key={`${view}:${level ?? ''}`}
      nodes={layout.nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onEdgeMouseEnter={(_, e) => setHoverEdge(e.id)}
      onEdgeMouseLeave={() => setHoverEdge(null)}
      colorMode="system"
      fitView
      minZoom={0.1}
      nodesDraggable={false}
      nodesConnectable={false}
      zoomOnDoubleClick={false}
      onNodeClick={(_, n) => {
        clearTimeout(clickTimer.current);
        clickTimer.current = setTimeout(() => onSelect(n.id), 230);
      }}
      onNodeDoubleClick={(_, n) => {
        clearTimeout(clickTimer.current);
        if (map.nodes.some(x => x.parent === n.id)) {
          onPath([...path, n.id]);
          onSelect(null);
        }
      }}
      onPaneClick={() => onSelect(null)}
      proOptions={{ hideAttribution: true }}
    >
      <Background />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

function edgeLabel(labels: string[]): string | undefined {
  return labels.length > 1 ? `${labels[0]} +${labels.length - 1}` : labels[0];
}

export function Crumbs({ map, root, path, onPath }: { map: StoredMap; root: string; path: string[]; onPath: (p: string[]) => void }) {
  if (path.length === 0) return null;
  const label = (id: string) => map.nodes.find(n => n.id === id)?.label ?? id;
  return (
    <nav className="crumbs">
      <button className="link" onClick={() => onPath([])}>{root}</button>
      {path.map((id, i) => (
        <span key={id}> / <button className="link" onClick={() => onPath(path.slice(0, i + 1))}>{label(id)}</button></span>
      ))}
    </nav>
  );
}
