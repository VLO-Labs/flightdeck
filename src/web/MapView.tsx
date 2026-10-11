// The map screen: a project's diagrams, generated from its code. Navigate by drilling into nodes;
// see what changed since the map was made; open the files behind any node; take a node to a chat.
import { useEffect, useMemo, useState } from 'react';
import { MAP_VIEWS, type MapResponse, type MapViewId, type Project } from '../shared/contracts.ts';
import { api } from './api.ts';
import { FileViewer, type MapPlace } from './FileViewer.tsx';
import { Crumbs, MapCanvas, liftEdges, nodesForFile } from './MapCanvas.tsx';
import type { EdgePart } from './graph.ts';

// The details panel's width; it floats over the canvas, which pans selected cards out from under it.
const PANEL_W = 340;

export type NodeRef = { view: MapViewId; nodeId: string; label: string };

// Shared by the Map screen and the chat's map pane: load a view, poll while it generates.
export function useMap(projectId: number, view: MapViewId) {
  const [data, setData] = useState<MapResponse | null>(null);
  const [error, setError] = useState('');
  const load = () => api.map(projectId, view).then(d => { setData(d); setError(''); }).catch(e => setError(e.message));
  useEffect(() => {
    setData(null);
    void load();
  }, [projectId, view]);
  const running = data?.job?.status === 'running';
  useEffect(() => {
    const t = setInterval(load, running ? 2000 : 15000);
    return () => clearInterval(t);
  }, [projectId, view, running]);
  return { data, error, setError, reload: load };
}

export function MapView({ project, onAskInChat }: { project: Project; onAskInChat: (nodes: NodeRef[]) => void }) {
  const [view, setView] = useState<MapViewId>('architecture');
  const { data, error, setError, reload } = useMap(project.id, view);
  const [path, setPath] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [fileLine, setFileLine] = useState<number | undefined>();
  const openFile = (f: string | null, line?: number) => { setFile(f); setFileLine(line); };
  const [focus, setFocus] = useState<{ id: string; seq: number } | null>(null);

  useEffect(() => { setPath([]); setSelected(null); }, [project.id, view]);
  // A refreshed map can drop or rename nodes: keep the reader's place as far as it still exists.
  useEffect(() => {
    if (!data?.map) return;
    const ids = new Set(data.map.nodes.map(n => n.id));
    setPath(p => { const i = p.findIndex(id => !ids.has(id)); return i === -1 ? p : p.slice(0, i); });
    setSelected(s => (s && ids.has(s) ? s : null));
  }, [data?.map?.generatedAt]);

  const map = data?.map ?? null;
  const running = data?.job?.status === 'running';
  const stale = useMemo(() => new Set(data?.staleNodeIds ?? []), [data]);
  const byId = useMemo(() => new Map((map?.nodes ?? []).map(n => [n.id, n])), [map]);
  const sel = selected ? byId.get(selected) : undefined;
  const hasChildren = (id: string) => (map?.nodes ?? []).some(n => n.parent === id);
  // The selected node's connections at this level, as drawn: what it uses, and what uses it.
  const links = useMemo(() => {
    if (!map || !sel) return { uses: [], usedBy: [], both: [] };
    const lifted = liftEdges(map.nodes, map.edges, path.at(-1) ?? null);
    const row = (other: string, parts: EdgePart[], twoWay: boolean) => ({ id: other, label: byId.get(other)?.label ?? other, parts, twoWay });
    return {
      uses: lifted.filter(e => e.from === sel.id && !e.twoWay).map(e => row(e.to, e.parts, false)),
      usedBy: lifted.filter(e => e.to === sel.id && !e.twoWay).map(e => row(e.from, e.parts, false)),
      both: lifted.filter(e => e.twoWay && (e.from === sel.id || e.to === sel.id)).map(e => row(e.from === sel.id ? e.to : e.from, e.parts, true)),
    };
  }, [map, sel, path, byId]);
  const goTo = (id: string) => { setSelected(id); setFocus(f => ({ id, seq: (f?.seq ?? 0) + 1 })); };

  // Where the open file sits on the map, and a way back to it: drill to the node's level and select it.
  const ancestors = (id: string) => {
    const out: string[] = [];
    for (let p = byId.get(id)?.parent ?? null; p; p = byId.get(p)?.parent ?? null) out.unshift(p);
    return out;
  };
  const places: MapPlace[] = useMemo(() => {
    if (!map || file === null || file === '' || file.endsWith('/')) return [];
    return nodesForFile(map, file).map(id => ({ id, trail: [...ancestors(id), id].map(a => byId.get(a)?.label ?? a).join(' › ') }));
  }, [map, file, byId]);
  const showOnMap = (id: string) => {
    setFile(null);
    setPath(ancestors(id));
    setSelected(id);
    setFocus(f => ({ id, seq: (f?.seq ?? 0) + 1 }));
  };

  const generate = async () => {
    setError('');
    try {
      await api.generateMap(project.id, view);
      await reload();
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
          {map && data?.baseMissing && (
            <span className="badge warn" title="The commit this map was made from no longer exists (rebased or reset), so what changed can't be told">
              Map's base commit is gone · refresh to be sure
            </span>
          )}
          {map && data && !data.baseMissing && data.changedFiles.length > 0 && (
            <span className="badge warn" title={`Changed since the map was made:\n${data.changedFiles.slice(0, 30).join('\n')}${data.changedFiles.length > 30 ? '\n…' : ''}`}>
              {changeSummary(data.changedFiles.length, stale.size)}
            </span>
          )}
          {running
            ? <button className="stop" onClick={() => api.stopMap(project.id).then(reload)}>Stop</button>
            : <button onClick={generate}>{map ? 'Refresh map' : 'Map this project'}</button>}
        </div>
      </header>

      {job && job.view === view && job.status !== 'done' && (
        <div className={`job-line ${job.status}`}>
          {job.status === 'running' && <>Mapping… {job.steps} step(s) · <span className="mono">{job.activity}</span></>}
          {job.status === 'failed' && (
            <>Mapping failed: {job.error} {map && 'The previous map is still shown.'} <button className="small" onClick={generate}>Try again</button></>
          )}
          {job.status === 'stopped' && <>Mapping stopped.{map && ' The previous map is still shown.'}</>}
        </div>
      )}
      {job && job.view !== view && job.status === 'running' && (
        <div className="job-line running">Mapping the {job.view} view… ({job.steps} steps)</div>
      )}
      {error && <div className="error job-line">{error}</div>}
      {map && <Crumbs map={map} root={project.name} path={path} onPath={p => { setPath(p); setSelected(null); }} />}

      <div className="map-body">
        <div className="map-canvas">
          {!data && !error && <div className="empty">Loading map…</div>}
          {data && !map && !running && (
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
          {map && (
            <MapCanvas map={map} view={view} stale={stale} path={path} onPath={setPath} selected={selected} onSelect={setSelected} focus={focus} remember coveredRight={PANEL_W} />
          )}
        </div>

        {sel && (
          <aside className="map-panel" style={{ width: PANEL_W }}>
            <div className="panel-kind">{sel.kind}</div>
            <h2 className="panel-title">{sel.label}</h2>
            <p>{sel.summary}</p>
            {stale.has(sel.id) && <p className="warn-text">Files behind this changed since the map was made, so this may be outdated.</p>}
            <div className="panel-actions">
              {hasChildren(sel.id) && <button onClick={() => { setPath([...path, sel.id]); setSelected(null); }}>Open ▸</button>}
              <button onClick={() => onAskInChat([{ view, nodeId: sel.id, label: sel.label }])}>Discuss in a new chat</button>
            </div>
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
            {(links.uses.length > 0 || links.usedBy.length > 0 || links.both.length > 0) && (
              <>
                {links.uses.length > 0 && <div className="label"><span className="dir-out">→</span> Uses</div>}
                {links.uses.map(l => <LinkRow key={`u${l.id}`} l={l} onGo={goTo} onOpen={openFile} />)}
                {links.usedBy.length > 0 && <div className="label"><span className="dir-in">←</span> Used by</div>}
                {links.usedBy.map(l => <LinkRow key={`b${l.id}`} l={l} onGo={goTo} onOpen={openFile} />)}
                {links.both.length > 0 && <div className="label"><span className="dir-out">⇄</span> Both ways</div>}
                {links.both.map(l => <LinkRow key={`w${l.id}`} l={l} onGo={goTo} onOpen={openFile} />)}
              </>
            )}
            <div className="label">Files</div>
            {sel.files.length === 0 && <div className="muted">None recorded.</div>}
            {sel.files.map(f => (
              <button key={f} className="link mono file-link" onClick={() => openFile(f)}>{f}</button>
            ))}
            <p className="panel-foot muted">
              Boxes, files and connections come from Claude reading the code; files are checked to exist. Descriptions are its summary.
            </p>
          </aside>
        )}
      </div>

      {file !== null && (
        <FileViewer project={project} path={file} line={fileLine} places={places} onOpen={f => openFile(f)} onClose={() => openFile(null)} onShowOnMap={showOnMap} />
      )}
    </div>
  );
}

// One connection: the other node (click to go there) and what flows, each part marked by whether
// the map cites the code for it ("seen in code", opens the file) or it's the model's inference.
function LinkRow({ l, onGo, onOpen }: {
  l: { id: string; label: string; parts: EdgePart[]; twoWay: boolean };
  onGo: (id: string) => void;
  onOpen: (file: string, line?: number) => void;
}) {
  return (
    <div className="link-row">
      <button className="link-row-name" onClick={() => onGo(l.id)} title="Go to this on the map">{l.label}</button>
      {l.parts.map((p, i) => {
        const m = p.evidence ? /^(.*?)(?::(\d+))?$/.exec(p.evidence) : null;
        return (
          <div key={i} className="link-part">
            <span className="link-row-what">{p.label || '—'}</span>
            {m
              ? <button className="link evidence" title={p.evidence} onClick={() => onOpen(m[1]!, m[2] ? Number(m[2]) : undefined)}>seen in code</button>
              : <span className="inferred" title="The map doesn't cite the code for this; it's Claude's reading of the project">inferred</span>}
          </div>
        );
      })}
    </div>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The change badge: a changed file means a box *may* be outdated, not that it is.
function changeSummary(files: number, boxes: number): string {
  if (boxes === 0) return `${plural(files, 'file')} changed since this map, none inside a mapped box`;
  return `${plural(files, 'file')} changed since this map · ${plural(boxes, 'box', 'boxes')} may be outdated`;
}
