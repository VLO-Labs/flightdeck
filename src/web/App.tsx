import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrowseResponse, Chat, Project } from '../shared/contracts.ts';
import { api } from './api.ts';
import { STACKS } from '../shared/stacks.ts';
import { ChatView } from './ChatView.tsx';
import { RulesView } from './RulesView.tsx';
import { MapView, type NodeRef } from './MapView.tsx';

type View = { kind: 'chat'; chatId: number } | { kind: 'rules' } | { kind: 'map' } | { kind: 'none' };

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | undefined>();
  const [chats, setChats] = useState<Chat[]>([]);
  const [view, setView] = useState<View>({ kind: 'none' });
  const [adding, setAdding] = useState<'existing' | 'new' | null>(null);
  // A chat to open once the project switch below has run (a new project opens its scaffold chat).
  const openAfterSwitch = useRef<number | null>(null);
  const [error, setError] = useState('');
  // Nodes handed from the Map screen to a freshly created chat, attached to its first message.
  const [handoff, setHandoff] = useState<{ chatId: number; nodes: NodeRef[] } | null>(null);

  useEffect(() => {
    api.projects().then(ps => {
      setProjects(ps);
      const saved = Number(localStorageGet('fd.project'));
      setProjectId(ps.find(p => p.id === saved)?.id ?? ps[0]?.id);
    }).catch(e => setError(String(e.message)));
  }, []);

  const refreshChats = useCallback(() => {
    if (projectId === undefined) return;
    api.chats(projectId).then(setChats).catch(e => setError(String(e.message)));
  }, [projectId]);

  useEffect(() => {
    setChats([]);
    setView(openAfterSwitch.current ? { kind: 'chat', chatId: openAfterSwitch.current } : { kind: 'none' });
    openAfterSwitch.current = null;
    if (projectId !== undefined) localStorageSet('fd.project', String(projectId));
    refreshChats();
  }, [projectId, refreshChats]);

  // Keep running/lock badges current without a push channel for the chat list.
  useEffect(() => {
    const t = setInterval(refreshChats, 3000);
    return () => clearInterval(t);
  }, [refreshChats]);

  const project = projects.find(p => p.id === projectId);
  const chat = view.kind === 'chat' ? chats.find(c => c.id === view.chatId) : undefined;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">Flightdeck</div>

        <label className="label">Project</label>
        <select value={projectId ?? ''} onChange={e => setProjectId(Number(e.target.value))}>
          {projects.length === 0 && <option value="">No projects yet</option>}
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div className="row-between">
          <button className="link" onClick={() => setAdding(a => (a === 'new' ? null : 'new'))}>{adding === 'new' ? 'Cancel' : '+ New project'}</button>
          <button className="link" onClick={() => setAdding(a => (a === 'existing' ? null : 'existing'))}>{adding === 'existing' ? 'Cancel' : '+ Add existing'}</button>
        </div>
        {adding === 'existing' && (
          <AddProject
            onAdded={p => {
              setProjects(ps => [...ps, p]);
              setProjectId(p.id);
              setAdding(null);
            }}
          />
        )}
        {adding === 'new' && (
          <NewProject
            onCreated={(p, chatId, err) => {
              // The project exists even if the scaffold turn couldn't start; the chat can be resent.
              if (err) setError(`Project created, but the scaffold didn't start: ${err}`);
              setProjects(ps => [...ps, p]);
              openAfterSwitch.current = chatId;
              setProjectId(p.id);
              setAdding(null);
            }}
          />
        )}

        {project && (
          <>
            <button className={`link ${view.kind === 'map' ? 'active' : ''}`} onClick={() => setView({ kind: 'map' })}>
              Map
            </button>
            <div className="row-between">
              <label className="label">Chats</label>
              <button
                className="small"
                onClick={async () => {
                  const c = await api.newChat(project.id);
                  setChats(cs => [c, ...cs]);
                  setView({ kind: 'chat', chatId: c.id });
                }}
              >
                New chat
              </button>
            </div>
            <nav className="chat-list">
              {chats.map(c => (
                <button
                  key={c.id}
                  className={`chat-item ${view.kind === 'chat' && view.chatId === c.id ? 'active' : ''}`}
                  onClick={() => setView({ kind: 'chat', chatId: c.id })}
                >
                  <span className="chat-title">{c.title}</span>
                  {c.running && <span className="badge run">running</span>}
                  {c.holdsEditLock && <span className="badge lock" title="This chat is changing code; other chats can't edit until it finishes">editing</span>}
                </button>
              ))}
            </nav>
            <button className={`link ${view.kind === 'rules' ? 'active' : ''}`} onClick={() => setView({ kind: 'rules' })}>
              Project settings
            </button>
            <div className="path" title={project.path}>{project.path}</div>
          </>
        )}
        {error && <div className="error">{error}</div>}
      </aside>

      <main className="main">
        {view.kind === 'chat' && chat && project && (
          <ChatView
            key={chat.id} chat={chat} project={project} onChanged={refreshChats}
            initialContext={handoff?.chatId === chat.id ? handoff.nodes : undefined}
          />
        )}
        {view.kind === 'rules' && project && (
          <RulesView key={project.id} project={project} onProjectChanged={p => setProjects(ps => ps.map(x => (x.id === p.id ? p : x)))} />
        )}
        {view.kind === 'map' && project && (
          <MapView
            key={project.id}
            project={project}
            onAskInChat={async nodes => {
              try {
                const c = await api.newChat(project.id);
                setChats(cs => [c, ...cs]);
                setHandoff({ chatId: c.id, nodes });
                setView({ kind: 'chat', chatId: c.id });
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          />
        )}
        {view.kind === 'none' && (
          <div className="empty">
            {project ? 'Open the map, a chat, or start a new chat.' : 'Add a project: a git repository on the box.'}
          </div>
        )}
      </main>
    </div>
  );
}

function AddProject({ onAdded }: { onAdded: (p: Project) => void }) {
  const [path, setPath] = useState('/home/vlolabs/dev/');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [browsing, setBrowsing] = useState(false);
  return (
    <form
      className="add-project"
      onSubmit={async e => {
        e.preventDefault();
        setError('');
        try {
          onAdded(await api.addProject(name.trim() || path.replace(/\/+$/, '').split('/').pop()!, path.trim()));
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <input value={path} onChange={e => setPath(e.target.value)} placeholder="/home/vlolabs/dev/vlolabs/hq" />
      <button type="button" className="small" onClick={() => setBrowsing(b => !b)}>{browsing ? 'Close browser' : 'Browse…'}</button>
      {browsing && <FolderBrowser onChoose={p => { setPath(p); setBrowsing(false); }} />}
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Name (defaults to folder)" />
      <button type="submit">Add</button>
      {error && <div className="error">{error}</div>}
    </form>
  );
}

// Walks folders under the box's ~/dev (the server refuses anything outside it). A git repository, or
// a folder of them, can be chosen; other folders can only be opened.
function FolderBrowser({ onChoose }: { onChoose: (path: string) => void }) {
  const [at, setAt] = useState<BrowseResponse | null>(null);
  const [error, setError] = useState('');
  const open = (p?: string) => api.browse(p).then(r => { setAt(r); setError(''); }).catch(e => setError((e as Error).message));
  useEffect(() => { open(); }, []);
  if (!at) return error ? <div className="error">{error}</div> : null;
  return (
    <div className="browser">
      {/* <bdi> keeps the path left-to-right inside the right-to-left box that trims it from the left */}
      <div className="browser-path" title={at.path}><bdi>{at.path}</bdi></div>
      {at.addable && <button type="button" className="small" onClick={() => onChoose(at.path)}>Choose this folder</button>}
      <div className="browser-list">
        {at.parent && <button type="button" className="browser-item" onClick={() => open(at.parent!)}>..</button>}
        {at.dirs.map(d => (
          <div key={d.path} className="browser-row">
            <button type="button" className="browser-item" onClick={() => open(d.path)}>{d.name}/</button>
            {d.addable && <button type="button" className="small" onClick={() => onChoose(d.path)}>Choose</button>}
          </div>
        ))}
        {at.dirs.length === 0 && <div className="muted">No folders here</div>}
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function NewProject({ onCreated }: { onCreated: (p: Project, chatId: number, error?: string) => void }) {
  const [name, setName] = useState('');
  // The folder follows the name until it's edited by hand.
  const [path, setPath] = useState<string | null>(null);
  const [stack, setStack] = useState<string>(STACKS[0].id);
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const folder = path ?? `/home/vlolabs/dev/vlolabs/${slug(name)}`;
  return (
    <form
      className="add-project"
      onSubmit={async e => {
        e.preventDefault();
        setError('');
        setBusy(true);
        try {
          const r = await api.createProject({ name: name.trim(), path: folder.trim(), stack, description });
          onCreated(r.project, r.chatId, r.error);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Name" required />
      <input value={folder} onChange={e => setPath(e.target.value)} placeholder="Folder on the box" />
      <select value={stack} onChange={e => setStack(e.target.value)}>
        {STACKS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
      <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="What is it? (optional, goes to Claude)" rows={3} />
      <button type="submit" disabled={busy || !slug(name)}>Create and scaffold</button>
      {error && <div className="error">{error}</div>}
    </form>
  );
}

// localStorage can throw (private mode, blocked storage); it only remembers the last project.
function localStorageGet(k: string) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function localStorageSet(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch { /* not essential */ }
}
