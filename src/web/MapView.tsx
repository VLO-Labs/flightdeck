// The map screen: a project's diagrams, generated from its code. Navigate by drilling into nodes;
// see what changed since the map was made; open the files behind any node; take a node to a chat.
import { useEffect, useMemo, useState } from 'react';
import { MAP_VIEWS, type MapResponse, type MapViewId, type Project } from '../shared/contracts.ts';
import { api } from './api.ts';
import { FileViewer } from './FileViewer.tsx';
import { Crumbs, MapCanvas } from './MapCanvas.tsx';

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

  useEffect(() => { setPath([]); setSelected(null); }, [project.id, view]);

  const map = data?.map ?? null;
  const running = data?.job?.status === 'running';
  const stale = useMemo(() => new Set(data?.staleNodeIds ?? []), [data]);
  const byId = useMemo(() => new Map((map?.nodes ?? []).map(n => [n.id, n])), [map]);
  const sel = selected ? byId.get(selected) : undefined;
  const hasChildren = (id: string) => (map?.nodes ?? []).some(n => n.parent === id);

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
          {map && data && data.changedFiles.length > 0 && (
            <span className="badge warn" title={data.changedFiles.slice(0, 30).join('\n')}>
              {data.changedFiles.length} file(s) changed since — {stale.size} node(s) affected
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
          {job.status === 'failed' && <>Mapping failed: {job.error}</>}
          {job.status === 'stopped' && <>Mapping stopped.</>}
        </div>
      )}
      {job && job.view !== view && job.status === 'running' && (
        <div className="job-line running">Mapping the {job.view} view… ({job.steps} steps)</div>
      )}
      {error && <div className="error job-line">{error}</div>}
      {map && <Crumbs map={map} root={project.name} path={path} onPath={p => { setPath(p); setSelected(null); }} />}

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
          {map && (
            <MapCanvas map={map} view={view} stale={stale} path={path} onPath={setPath} selected={selected} onSelect={setSelected} />
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
