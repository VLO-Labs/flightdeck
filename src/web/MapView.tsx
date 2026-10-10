// The map screen: a project's diagrams, generated from its code. Navigate by drilling into nodes;
// see what changed since the map was made; open the files behind any node.
import { useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, Handle, Position, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import ELK from 'elkjs/lib/elk.bundled.js';
import { MAP_VIEWS, type MapEdge, type MapNode, type MapResponse, type MapViewId, type Project } from '../shared/contracts.ts';
import { api } from './api.ts';
import { FileViewer } from './FileViewer.tsx';

const elk = new ELK();
const W = 240;
const heightOf = (n: MapNode) => 78 + Math.min(n.fields.length, 12) * 17;

type CardData = { node: MapNode; stale: boolean; childCount: number; selected: boolean };

function NodeCard({ data }: NodeProps<Node<CardData>>) {
  const { node, stale, childCount, selected } = data;
  return (
    <div className={`map-node kind-${node.kind} ${stale ? 'stale' : ''} ${selected ? 'selected' : ''}`} style={{ width: W }}>
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
        {stale && <span className="stale-tag">changed</span>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { card: NodeCard };

// Edges can join nodes at any depth; show each one between the visible ancestors of its ends.
function liftEdges(nodes: MapNode[], edges: MapEdge[], level: string | null) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const visibleAncestor = (id: string): string | undefined => {
    for (let n = byId.get(id); n; n = n.parent ? byId.get(n.parent) : undefined) if (n.parent === level) return n.id;
    return undefined;
  };
  const out = new Map<string, { from: string; to: string; labels: string[] }>();
  for (const e of edges) {
    const from = visibleAncestor(e.from);
    const to = visibleAncestor(e.to);
    if (!from || !to || from === to) continue;
    const key = `${from}→${to}`;
    const cur = out.get(key) ?? { from, to, labels: [] };
    if (e.label && !cur.labels.includes(e.label)) cur.labels.push(e.label);
    out.set(key, cur);
  }
  return [...out.values()];
}

export function MapView({ project }: { project: Project }) {
  const [view, setView] = useState<MapViewId>('architecture');
  const [data, setData] = useState<MapResponse | null>(null);
  const [path, setPath] = useState<string[]>([]); // drill-down trail of node ids
  const [selected, setSelected] = useState<string | null>(null);
  const [layout, setLayout] = useState<{ nodes: Node<CardData>[]; edges: Edge[] } | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = () => api.map(project.id, view).then(setData).catch(e => setError(e.message));
  useEffect(() => {
    setData(null);
    setPath([]);
    setSelected(null);
    void load();
  }, [project.id, view]);

  // Poll fast while a generation runs, slowly otherwise (staleness follows edits made elsewhere).
  const running = data?.job?.status === 'running';
  useEffect(() => {
    const t = setInterval(load, running ? 2000 : 15000);
    return () => clearInterval(t);
  }, [project.id, view, running]);

  const map = data?.map ?? null;
  const level = path.at(-1) ?? null;
  const stale = useMemo(() => new Set(data?.staleNodeIds ?? []), [data]);

  useEffect(() => {
    if (!map) return setLayout(null);
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
        'elk.layered.spacing.nodeNodeBetweenLayers': '80',
        'elk.edgeRouting': 'SPLINES',
      },
      children: visible.map(n => ({ id: n.id, width: W, height: heightOf(n) })),
      edges: lifted.map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] })),
    }).then(g => {
      if (cancelled) return;
      const pos = new Map((g.children ?? []).map(c => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
      setLayout({
        nodes: visible.map(n => ({
          id: n.id, type: 'card', position: pos.get(n.id) ?? { x: 0, y: 0 },
          data: { node: n, stale: stale.has(n.id), childCount: childCount(n.id), selected: selected === n.id },
        })),
        edges: lifted.map((e, i) => ({
          id: `e${i}`, source: e.from, target: e.to,
          label: e.labels.length > 1 ? `${e.labels[0]} +${e.labels.length - 1}` : e.labels[0],
          animated: stale.has(e.from) || stale.has(e.to),
        })),
      });
    });
    return () => { cancelled = true; };
  }, [map, level, view, stale, selected]);

  const byId = useMemo(() => new Map((map?.nodes ?? []).map(n => [n.id, n])), [map]);
  const sel = selected ? byId.get(selected) : undefined;
  const hasChildren = (id: string) => (map?.nodes ?? []).some(n => n.parent === id);

  const generate = async () => {
    setError('');
    try {
      await api.generateMap(project.id, view);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const job = data?.job;
  return (
    <div className="mapview">
      <header className="map-header">
        <div className="map-tabs">
          {MAP_VIEWS.map(v => (
            <button key={v.id} className={v.id === view ? 'on' : ''} onClick={() => setView(v.id)}>{v.label}</button>
          ))}
        </div>
        <div className="map-meta">
          {map && (
            <span className="muted" title={map.warnings.join('\n')}>
              Mapped {new Date(map.generatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
              {map.warnings.length > 0 && ` · ${map.warnings.length} warning(s)`}
            </span>
          )}
          {map && data && data.changedFiles.length > 0 && (
            <span className="badge warn" title={data.changedFiles.slice(0, 30).join('\n')}>
              {data.changedFiles.length} file(s) changed since — {stale.size} node(s) affected
            </span>
          )}
          {running
            ? <button className="stop" onClick={() => api.stopMap(project.id).then(load)}>Stop</button>
            : <button onClick={generate}>{map ? 'Refresh map' : 'Map this project'}</button>}
        </div>
      </header>

      {job && job.view === view && job.status !== 'done' && (
        <div className={`job-line ${job.status}`}>
          {job.status === 'running' && <>Mapping… {job.steps} step(s) · <span className="mono">{job.activity}</span></>}
          {job.status === 'failed' && <>Mapping failed: {job.error}</>}
          {job.status === 'stopped' && <>Mapping stopped.</>}
        </div>
      )}
      {job && job.view !== view && job.status === 'running' && (
        <div className="job-line running">Mapping the {job.view} view… ({job.steps} steps)</div>
      )}
      {error && <div className="error job-line">{error}</div>}

      {path.length > 0 && (
        <nav className="crumbs">
          <button className="link" onClick={() => { setPath([]); setSelected(null); }}>{project.name}</button>
          {path.map((id, i) => (
            <span key={id}> / <button className="link" onClick={() => { setPath(path.slice(0, i + 1)); setSelected(null); }}>{byId.get(id)?.label ?? id}</button></span>
          ))}
        </nav>
      )}

      <div className="map-body">
        <div className="map-canvas">
          {!map && !running && (
            <div className="empty">
              <div>
                <p>No {MAP_VIEWS.find(v => v.id === view)!.label.toLowerCase()} map yet.</p>
                <p className="muted">
                  “Map this project” has Claude read the code (read-only, on this project's Discuss model) and draw it.
                  On a large repo that can take several minutes and a noticeable share of your plan's usage.
                </p>
              </div>
            </div>
          )}
          {layout && (
            <ReactFlow
              key={`${view}:${level ?? ''}`}
              nodes={layout.nodes}
              edges={layout.edges}
              nodeTypes={nodeTypes}
              colorMode="system"
              fitView
              nodesDraggable={false}
              nodesConnectable={false}
              onNodeClick={(_, n) => setSelected(n.id)}
              onNodeDoubleClick={(_, n) => { if (hasChildren(n.id)) { setPath([...path, n.id]); setSelected(null); } }}
              onPaneClick={() => setSelected(null)}
              proOptions={{ hideAttribution: true }}
            >
              <Background />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
        </div>

        {sel && (
          <aside className="map-panel">
            <div className="row-between">
              <strong>{sel.label}</strong>
              <span className="badge">{sel.kind}</span>
            </div>
            <p>{sel.summary}</p>
            {stale.has(sel.id) && <p className="warn-text">Files behind this changed since the map was made.</p>}
            {hasChildren(sel.id) && (
              <button onClick={() => { setPath([...path, sel.id]); setSelected(null); }}>Open ▸</button>
            )}
            {sel.fields.length > 0 && (
              <>
                <div className="label">Fields</div>
                <table className="fields">
                  <tbody>
                    {sel.fields.map(f => <tr key={f.name}><td className="mono">{f.name}</td><td>{f.type}</td><td className="muted">{f.note}</td></tr>)}
                  </tbody>
                </table>
              </>
            )}
            <div className="label">Files</div>
            {sel.files.length === 0 && <div className="muted">None recorded.</div>}
            {sel.files.map(f => (
              <button key={f} className="link mono file-link" onClick={() => setFile(f)}>{f}</button>
            ))}
          </aside>
        )}
      </div>

      {file !== null && <FileViewer project={project} path={file} onOpen={setFile} onClose={() => setFile(null)} />}
    </div>
  );
}
