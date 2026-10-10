import { useCallback, useEffect, useState } from 'react';
import type { Chat, Project } from '../shared/contracts.ts';
import { api } from './api.ts';
import { ChatView } from './ChatView.tsx';
import { RulesView } from './RulesView.tsx';

type View = { kind: 'chat'; chatId: number } | { kind: 'rules' } | { kind: 'none' };

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | undefined>();
  const [chats, setChats] = useState<Chat[]>([]);
  const [view, setView] = useState<View>({ kind: 'none' });
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');

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
    setView({ kind: 'none' });
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
        <button className="link" onClick={() => setAdding(a => !a)}>{adding ? 'Cancel' : '+ Add project'}</button>
        {adding && (
          <AddProject
            onAdded={p => {
              setProjects(ps => [...ps, p]);
              setProjectId(p.id);
              setAdding(false);
            }}
          />
        )}

        {project && (
          <>
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
              Approval rules
            </button>
            <div className="path" title={project.path}>{project.path}</div>
          </>
        )}
        {error && <div className="error">{error}</div>}
      </aside>

      <main className="main">
        {view.kind === 'chat' && chat && project && (
          <ChatView key={chat.id} chat={chat} project={project} onChanged={refreshChats} />
        )}
        {view.kind === 'rules' && project && <RulesView key={project.id} project={project} />}
        {view.kind === 'none' && (
          <div className="empty">
            {project ? 'Open a chat or start a new one.' : 'Add a project: a git repository on the box.'}
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
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Name (defaults to folder)" />
      <button type="submit">Add</button>
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
