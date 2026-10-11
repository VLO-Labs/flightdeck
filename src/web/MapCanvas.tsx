// The diagram itself, shared by the Map screen and the map pane inside a chat: auto-layout of
// one level of a map, drill-down by double-click, and markers (stale, selected, context, heat).
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, BaseEdge, Controls, Handle, MarkerType, Position,
  useReactFlow, type Edge, type EdgeProps, type Node, type NodeProps, type ReactFlowInstance, type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkExtendedEdge } from 'elkjs/lib/elk-api.js';
import type { CheckResult, MapNode, MapViewId, StoredMap } from '../shared/contracts.ts';
import { liftEdges, type Heat, type LiftedEdge } from './graph.ts';
import type { PlannedNode, PlanStatus } from '../shared/plan.ts';

export { liftEdges, nodesForFile, type Heat, type LiftedEdge } from './graph.ts';

const elk = new ELK();


// ---------------------------------------------------------------------------------------------
// Card geometry. Cards are drawn at exactly the height the layout used, so edges always meet
// their border: the title wraps to at most two lines, the summary is clamped to two.
// ---------------------------------------------------------------------------------------------

const W = 264;
const TITLE_CHARS = 26; // per line at the title's size in a W-wide card (conservative)
const FIELDS_MAX = 12;
const titleLines = (label: string) => (label.length > TITLE_CHARS ? 2 : 1);
// Sizes match the card CSS (line heights: kind 16, title 20, summary 19×2 + 2, field 18, foot 20).
const heightOf = (n: MapNode, hasChildren: boolean) =>
  20 /* padding + border */ + 16 /* kind */ + titleLines(n.label) * 20 + (n.summary ? 40 : 0)
  + Math.min(n.fields.length, FIELDS_MAX + 1) * 18 + (n.fields.length ? 4 : 0) + (hasChildren ? 20 : 0);

// Columns for the architecture view, left to right, from the kinds the generator assigns.
// Only a hint to the layout: it orders columns, it never adds or removes a relationship.
const CATEGORY: Record<string, number> = {
  ui: 0, app: 0,
  service: 1, worker: 1, module: 1, library: 1,
  datastore: 2, queue: 2,
  external: 3,
};

// On a plan: what the plan does to this card; `inside` = it changes something within; `same` = untouched.
type PlanMark = PlanStatus | 'inside' | 'same';
const PLAN_TAG: Record<PlanMark, string> = { added: 'new', changed: 'changed', removed: 'removed', inside: 'changes inside', same: '' };
// After a check of what was built (PLAN.md §10).
export const CHECK_TAG: Record<CheckResult, string> = { verified: '✓ verified', missing: '✗ missing', review: '? needs review', unexpected: '! unexpected' };

type CardData = {
  node: MapNode; stale: boolean; children: string[]; selected: boolean; inContext: boolean;
  heat?: Heat; dim: boolean; height: number; plan?: PlanMark; check?: CheckResult;
};

function NodeCard({ data }: NodeProps<Node<CardData>>) {
  const { node, stale, children, selected, inContext, heat, dim, height, plan, check } = data;
  // Name what's inside instead of counting it ("Routes, Billing +5"), within the card's width.
  let inside = '';
  if (children.length) {
    const shown: string[] = [];
    for (const c of children) {
      if ((shown.join(', ') + c).length > 30 && shown.length) break;
      shown.push(c);
    }
    inside = shown.join(', ') + (children.length > shown.length ? ` +${children.length - shown.length}` : '');
  }
  return (
    <div
      className={`map-node kind-${node.kind} ${stale ? 'stale' : ''} ${selected ? 'selected' : ''} ${inContext ? 'in-context' : ''} ${heat ? `heat-${heat}` : ''} ${dim ? 'dim' : ''} ${plan ? `plan-${plan}` : ''}`}
      style={{ width: W, height }}
      title={node.label}
    >
      <Handle type="target" position={Position.Left} />
      {/* Status tags share the kind line, so a card's height never depends on them. */}
      <div className="map-node-kind">
        <span>{node.kind}</span>
        {heat === 'edit' && <span className="heat-tag edit">edited</span>}
        {heat === 'read' && <span className="heat-tag read">read</span>}
        {check
          ? <span className={`check-tag ${check}`}>{CHECK_TAG[check]}</span>
          : plan && plan !== 'same' && !heat && <span className={`plan-tag ${plan}`}>{PLAN_TAG[plan]}</span>}
        {stale && !heat && !plan && <span className="stale-tag" title="Files behind this changed since the map was made; it may need a refresh">may be outdated</span>}
      </div>
      <div className="map-node-label">{node.label}</div>
      {node.summary && <div className="map-node-summary">{node.summary}</div>}
      {node.fields.length > 0 && (
        <div className="map-node-fields">
          {node.fields.slice(0, FIELDS_MAX).map(f => (
            <div key={f.name}><span>{f.name}</span> <span className="muted">{f.type}{f.note ? ` · ${f.note}` : ''}</span></div>
          ))}
          {node.fields.length > FIELDS_MAX && <div className="muted">+{node.fields.length - FIELDS_MAX} more</div>}
        </div>
      )}
      {inside && (
        <div className="map-node-foot">
          <span className="inside" title={children.join(', ')}>▸ {inside}</span>
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { card: NodeCard };

// ---------------------------------------------------------------------------------------------
// Edges are drawn along the route ELK computed (right angles around the cards), not React Flow's
// own curves, which know nothing about the other cards.
// ---------------------------------------------------------------------------------------------

type Point = { x: number; y: number };
type Role = 'out' | 'in' | 'both' | 'hover' | 'dim' | 'plain';
type RouteData = { points: Point[]; label?: string; labelAt?: Point; showLabel: boolean; role: Role; plan?: PlanStatus };

function RouteEdge({ id, data, markerStart, markerEnd }: EdgeProps<Edge<RouteData>>) {
  const pts = data?.points ?? [];
  if (pts.length < 2) return null;
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
  const show = data!.showLabel && data!.label && data!.labelAt;
  return (
    <BaseEdge
      id={id} path={path} markerStart={markerStart} markerEnd={markerEnd} className={`route route-${data!.role}${data!.plan ? ` plan-${data!.plan}` : ''}`}
      interactionWidth={14}
      label={show ? data!.label : undefined} labelX={data!.labelAt?.x} labelY={data!.labelAt?.y}
      labelBgPadding={[5, 3]} labelBgBorderRadius={4}
      labelStyle={{ fill: 'var(--text)', fontSize: 12 }} labelBgStyle={{ fill: 'var(--panel)', stroke: 'var(--line)' }}
    />
  );
}
const edgeTypes = { route: RouteEdge };

// Up to this many edges, every label shows; past it, labels show for the hovered edge and the
// selected card's edges only, or the map turns into a wall of text.
const ALWAYS_LABEL = 8;

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

type Layout = {
  key: string;
  boxes: Map<string, { x: number; y: number; height: number }>;
  routes: Map<string, { points: Point[]; labelAt?: Point }>;
  lifted: LiftedEdge[];
};

// Hands the canvas's instance to MapCanvas. Rendered inside <ReactFlow>, so it works without a
// provider; `onInit` isn't relied on (it doesn't fire when nodes arrive pre-measured).
function InstanceRef({ into }: { into: { current: ReactFlowInstance<Node<CardData>, Edge<RouteData>> | null } }) {
  into.current = useReactFlow<Node<CardData>, Edge<RouteData>>();
  return null;
}

// Where each level was last left, so drilling in and back (or reopening the map) doesn't refit.
const viewports = new Map<string, Viewport>();

export function MapCanvas({
  map, view, stale, path, onPath, selected, onSelect, inContext, heat, focus, remember, coveredRight = 0, minFitZoom = 0.65, plan = false, checks,
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
  focus?: { id: string; seq: number } | null; // center this node (seq changes on each request)
  remember?: boolean; // keep each level's pan/zoom for when it's shown again (the Map screen)
  coveredRight?: number; // px of the canvas's right side covered by a panel while something is selected
  minFitZoom?: number; // the initial fit never zooms out further than this (text stays readable)
  plan?: boolean; // the map is a plan laid over the current map: mark what it adds, changes, removes
  checks?: Map<string, CheckResult>; // by node id: how each planned part turned out
}) {
  const level = path.at(-1) ?? null;
  const levelKey = `${view}:${level ?? ''}`;
  // A layout belongs to one version of the map: after a refresh, node ids can change, and drawing
  // the new nodes with the old layout would look up positions that don't exist.
  const layoutKey = `${map.generatedAt}:${levelKey}`;
  const [layout, setLayout] = useState<Layout | null>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const flow = useRef<ReactFlowInstance<Node<CardData>, Edge<RouteData>> | null>(null);
  // A double-click also fires two clicks; hold each click briefly so a double-click is only a drill.
  const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(clickTimer.current), []);

  const visible = useMemo(() => map.nodes.filter(n => n.parent === level), [map, level]);
  const childLabels = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const n of map.nodes) if (n.parent) out.set(n.parent, [...(out.get(n.parent) ?? []), n.label]);
    return out;
  }, [map]);

  // The layout depends on the map and the level only, never on selection or highlighting.
  useEffect(() => {
    const lifted = liftEdges(map.nodes, map.edges, level);
    const heights = new Map(visible.map(n => [n.id, heightOf(n, childLabels.has(n.id))]));
    const partitioned = view === 'architecture' && new Set(visible.map(n => CATEGORY[n.kind] ?? 1)).size > 1;
    let cancelled = false;
    elk.layout({
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': view === 'flows' && level !== null ? 'DOWN' : 'RIGHT',
        'elk.edgeRouting': 'ORTHOGONAL',
        'elk.spacing.nodeNode': '28',
        'elk.layered.spacing.nodeNodeBetweenLayers': '72',
        'elk.spacing.edgeEdge': '12',
        'elk.spacing.edgeNode': '20',
        'elk.layered.spacing.edgeNodeBetweenLayers': '20',
        'elk.layered.spacing.edgeEdgeBetweenLayers': '10',
        // Straighter edges and fewer bends than the default placement.
        'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
        'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
        'elk.layered.thoroughness': '30',
        'elk.separateConnectedComponents': 'false',
        ...(partitioned ? { 'elk.partitioning.activate': 'true' } : {}),
      },
      children: visible.map(n => ({
        id: n.id, width: W, height: heights.get(n.id)!,
        ...(partitioned ? { layoutOptions: { 'elk.partitioning.partition': String(CATEGORY[n.kind] ?? 1) } } : {}),
      })),
      edges: lifted.map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] })),
    }).then(g => {
      if (cancelled) return;
      const boxes = new Map((g.children ?? []).map(c => [c.id, { x: c.x ?? 0, y: c.y ?? 0, height: heights.get(c.id)! }]));
      const routes = new Map(((g.edges ?? []) as ElkExtendedEdge[]).map(e => {
        const s = e.sections?.[0];
        const points = s ? [s.startPoint, ...(s.bendPoints ?? []), s.endPoint] : [];
        return [e.id, { points, labelAt: longestMidpoint(points) }];
      }));
      setLayout({ key: layoutKey, boxes, routes, lifted });
    });
    return () => { cancelled = true; };
  }, [map, level, view, layoutKey, visible, childLabels]);

  // Place the view once a level's layout is ready: where it was last left, or fitted. Done here
  // rather than with React Flow's fitView prop, which waits for a measuring pass that pre-measured
  // nodes never trigger (it then fits late, on some unrelated re-render).
  const vpKey = `${map.generatedAt}:${levelKey}`;
  useEffect(() => {
    if (!layout || layout.key !== layoutKey) return;
    const saved = remember ? viewports.get(vpKey) : undefined;
    // Fit from the layout itself (React Flow's fitView waits on a measuring pass these pre-measured
    // nodes never get). Never so far out that card text stops being readable; pan to see the rest.
    // Timers, not animation frames: frames don't run in a background tab, and the view should be
    // right whenever the tab is shown.
    let timer: ReturnType<typeof setTimeout> | undefined, tries = 0;
    const fit = () => {
      const el = wrap.current, f = flow.current;
      // React Flow renders its children (and so hands over its instance) a beat later, and ignores
      // viewport calls until pan/zoom is set up on a sized container: wait for all three.
      if (!el || !f || el.clientWidth === 0 || !f.viewportInitialized) { if (tries++ < 100) timer = setTimeout(fit, 20); return; }
      if (saved) { void f.setViewport(saved); return; }
      const bs = [...layout.boxes.values()];
      const minX = Math.min(...bs.map(b => b.x)), minY = Math.min(...bs.map(b => b.y));
      const bw = Math.max(...bs.map(b => b.x + W)) - minX, bh = Math.max(...bs.map(b => b.y + b.height)) - minY;
      const pad = 24;
      const zoom = Math.min(1, Math.max(minFitZoom, Math.min((el.clientWidth - 2 * pad) / bw, (el.clientHeight - 2 * pad) / bh)));
      // Centered when it fits; otherwise start from the top-left, where the layout begins.
      const x = bw * zoom <= el.clientWidth - 2 * pad ? (el.clientWidth - bw * zoom) / 2 - minX * zoom : pad - minX * zoom;
      const y = bh * zoom <= el.clientHeight - 2 * pad ? (el.clientHeight - bh * zoom) / 2 - minY * zoom : pad - minY * zoom;
      void f.setViewport({ x, y, zoom });
    };
    fit();
    return () => clearTimeout(timer);
  }, [layout]);

  // Center a node on request (from the details panel's connection list), keeping the zoom readable.
  useEffect(() => {
    if (!focus || !layout || !flow.current) return;
    const b = layout.boxes.get(focus.id);
    if (!b) return;
    const zoom = Math.max(flow.current.getZoom(), 0.75);
    void flow.current.setCenter(b.x + W / 2, b.y + b.height / 2, { zoom, duration: 0 });
  }, [focus?.seq, layout]);

  // Keep the selected card in view. The details panel floats over the canvas's right side (so the
  // canvas never resizes on selection); a card under it, or off screen, is panned into the free part.
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const f = flow.current, box = wrap.current?.getBoundingClientRect();
    const b = selected && layout ? layout.boxes.get(selected) : undefined;
    if (!f || !box || !b) return;
    const right = box.right - coveredRight;
    const tl = f.flowToScreenPosition({ x: b.x, y: b.y });
    const br = f.flowToScreenPosition({ x: b.x + W, y: b.y + b.height });
    if (tl.x >= box.left && tl.y >= box.top && br.x <= right && br.y <= box.bottom) return;
    const zoom = f.getZoom();
    // Center it in the uncovered area: shift the target right by half the covered width.
    void f.setCenter(b.x + W / 2 + coveredRight / 2 / zoom, b.y + b.height / 2, { zoom, duration: 0 });
  }, [selected, layout]);

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

  // On a plan, each card's mark: its own status, or that something inside it changes.
  const planMarks = useMemo(() => {
    const out = new Map<string, PlanMark>();
    if (!plan) return out;
    const byId = new Map(map.nodes.map(n => [n.id, n as PlannedNode]));
    for (const n of byId.values()) {
      if (!n.status) continue;
      out.set(n.id, n.status);
      for (let p = n.parent ? byId.get(n.parent) : undefined; p; p = p.parent ? byId.get(p.parent) : undefined) {
        if (!out.has(p.id)) out.set(p.id, 'inside');
      }
    }
    return out;
  }, [map, plan]);

  if (!layout || layout.key !== layoutKey) return null;

  // Selection: the selected card's edges are drawn by direction (uses / used by), its neighbours
  // stay clear, everything else steps back.
  const sel = selected && layout.boxes.has(selected) ? selected : null;
  const neighbours = new Set<string>();
  if (sel) for (const e of layout.lifted) {
    if (e.from === sel) neighbours.add(e.to);
    if (e.to === sel) neighbours.add(e.from);
  }
  const hovered = hoverEdge ? layout.lifted[Number(hoverEdge.slice(1))] : undefined;

  const nodes: Node<CardData>[] = visible.filter(n => layout.boxes.has(n.id)).map(n => {
    const b = layout.boxes.get(n.id)!;
    const related = !sel || n.id === sel || neighbours.has(n.id) || (hovered && (hovered.from === n.id || hovered.to === n.id));
    return {
      // Size and handles are given, not measured: React Flow drops measured handle positions whenever
      // it receives a node object without `measured` (every render here), and edges need them.
      id: n.id, type: 'card', position: { x: b.x, y: b.y },
      measured: { width: W, height: b.height },
      handles: [
        { type: 'target', position: Position.Left, x: 0, y: b.height / 2, width: 1, height: 1 },
        { type: 'source', position: Position.Right, x: W, y: b.height / 2, width: 1, height: 1 },
      ],
      data: {
        node: n, stale: stale.has(n.id), children: childLabels.get(n.id) ?? [], selected: n.id === sel,
        inContext: inContext?.has(n.id) ?? false, heat: visibleHeat.get(n.id), dim: !related, height: b.height,
        plan: plan ? planMarks.get(n.id) ?? 'same' : undefined,
        check: checks?.get(n.id),
      },
    };
  });

  const arrow = (color: string) => ({ type: MarkerType.ArrowClosed, width: 14, height: 14, color });
  const edges: Edge<RouteData>[] = layout.lifted.map((e, i) => {
    const id = `e${i}`;
    const r = layout.routes.get(id)!;
    let role: Role = 'plain';
    if (id === hoverEdge) role = 'hover';
    else if (sel) role = e.twoWay && (e.from === sel || e.to === sel) ? 'both' : e.from === sel ? 'out' : e.to === sel ? 'in' : 'dim';
    const planColor = e.status === 'added' ? 'var(--good)' : e.status === 'removed' ? 'var(--bad)' : e.status === 'changed' ? 'var(--plan-changed)' : undefined;
    const color = role === 'out' || role === 'both' ? 'var(--accent)' : role === 'in' ? 'var(--good)' : role === 'hover' ? 'var(--text)' : role === 'dim' ? 'var(--line)' : planColor ?? 'var(--muted)';
    const label = e.labels.length > 1 ? `${e.labels[0]} +${e.labels.length - 1}` : e.labels[0];
    const showLabel = role === 'hover' || role === 'out' || role === 'in' || role === 'both' || (!sel && layout.lifted.length <= ALWAYS_LABEL);
    return {
      id, source: e.from, target: e.to, type: 'route',
      markerEnd: arrow(color), markerStart: e.twoWay ? arrow(color) : undefined,
      zIndex: role === 'dim' || role === 'plain' ? 0 : 1,
      data: { ...r, label, showLabel, role, plan: e.status },
      animated: visibleHeat.has(e.from) && visibleHeat.has(e.to),
    };
  });

  return (
    <div ref={wrap} className="map-flow">
    <ReactFlow
      key={levelKey}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      minZoom={0.15}
      maxZoom={2}
      onMoveEnd={(_, vp) => { if (remember) viewports.set(vpKey, vp); }}
      onEdgeMouseEnter={(_, e) => setHoverEdge(e.id)}
      onEdgeMouseLeave={() => setHoverEdge(null)}
      colorMode="system"
      nodesDraggable={false}
      nodesConnectable={false}
      zoomOnDoubleClick={false}
      onNodeClick={(_, n) => {
        clearTimeout(clickTimer.current);
        clickTimer.current = setTimeout(() => onSelect(n.id), 230);
      }}
      onNodeDoubleClick={(_, n) => {
        clearTimeout(clickTimer.current);
        if (childLabels.has(n.id)) {
          onPath([...path, n.id]);
          onSelect(null);
        }
      }}
      onPaneClick={() => onSelect(null)}
      proOptions={{ hideAttribution: true }}
    >
      <InstanceRef into={flow} />
      <Background />
      <Controls showInteractive={false} />
    </ReactFlow>
    </div>
  );
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
