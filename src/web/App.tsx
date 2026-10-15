import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrowseResponse, Chat, Project } from '../shared/contracts.ts';
import { z } from 'zod';
import { api, type Limits } from './api.ts';
import { tildify } from './paths.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { STACKS } from '../shared/stacks.ts';
import { ChatView } from './ChatView.tsx';
import { RulesView } from './RulesView.tsx';
import { MapView, type MapNav, type NodeRef } from './MapView.tsx';
import { formatRoute, parseRoute, type Route } from './route.ts';
import { remember } from './workspace.ts';

type View = { kind: 'chat'; chatId: number } | { kind: 'rules' } | { kind: 'map' } | { kind: 'none' };

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | undefined>();
  const [chats, setChats] = useState<Chat[]>([]);
  const [view, setView] = useState<View>({ kind: 'none' });
  const [adding, setAdding] = useState<'existing' | 'new' | null>(null);
  // The screen to open once the project switch below has run: from the URL on load and on
  // Back/Forward, or a new project's scaffold chat.
  const viewAfterSwitch = useRef<View | null>(null);
  // The map screen's own place (view tab, drill-down, selection): read from the URL, kept in it.
  const [mapNav, setMapNav] = useState<MapNav>({ view: 'architecture', at: [], node: null });
  const [mapNavSeq, setMapNavSeq] = useState(0); // bumps when the URL (not the map) moved the map
  const loaded = useRef(false);
  const [error, setError] = useState('');
  // Nodes handed from the Map screen to a freshly created chat, attached to its first message.
  const [handoff, setHandoff] = useState<{ chatId: number; nodes: NodeRef[] } | null>(null);
  // Narrow screens: with a chat open the sidebar steps aside; the chat's menu brings it back.
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    api.projects().then(ps => {
      setProjects(ps);
      const route = parseRoute(location.pathname, location.search);
      const fromUrl = ps.find(p => p.id === route.projectId)?.id;
      if (fromUrl !== undefined) applyRoute(route);
      const saved = Number(localStorageGet('fd.project'));
      setProjectId(fromUrl ?? ps.find(p => p.id === saved)?.id ?? ps[0]?.id);
      loaded.current = true;
    }).catch(e => setError(String(e.message)));
  }, []);

  const refreshChats = useCallback(() => {
    if (projectId === undefined) return;
    api.chats(projectId).then(setChats).catch(e => setError(String(e.message)));
  }, [projectId]);

  useEffect(() => {
    setChats([]);
    setView(viewAfterSwitch.current ?? { kind: 'none' });
    viewAfterSwitch.current = null;
    if (projectId !== undefined) localStorageSet('fd.project', String(projectId));
    refreshChats();
  }, [projectId, refreshChats]);

  // A route's screen, for when its project is (or becomes) the current one.
  function applyRoute(r: Route) {
    const v: View = r.screen === 'map' ? { kind: 'map' } : r.screen === 'chat' ? { kind: 'chat', chatId: r.chatId }
      : r.screen === 'settings' ? { kind: 'rules' } : { kind: 'none' };
    if (r.screen === 'map') { setMapNav({ view: r.mapView, at: r.at, node: r.node }); setMapNavSeq(n => n + 1); }
    viewAfterSwitch.current = v;
    setView(v);
  }

  // The URL follows the screen: a new entry when the screen changes (so Back works), a silent
  // update when only the map's place within it moves.
  const lastScreen = useRef('');
  useEffect(() => {
    if (!loaded.current || projectId === undefined) return;
    const r: Route = view.kind === 'map' ? { projectId, screen: 'map', mapView: mapNav.view, at: mapNav.at, node: mapNav.node }
      : view.kind === 'chat' ? { projectId, screen: 'chat', chatId: view.chatId }
      : view.kind === 'rules' ? { projectId, screen: 'settings' } : { projectId, screen: 'none' };
    const url = formatRoute(r);
    const screen = url.split('?')[0]!.replace(/\/map\/.*$/, '/map');
    if (url === location.pathname + location.search) { lastScreen.current = screen; return; }
    if (screen !== lastScreen.current && lastScreen.current !== '') history.pushState(null, '', url);
    else history.replaceState(null, '', url);
    lastScreen.current = screen;
  }, [projectId, view, mapNav]);

  // Back / Forward: go where the URL says.
  useEffect(() => {
    const onPop = () => {
      const r = parseRoute(location.pathname, location.search);
      if (r.projectId === undefined || !projects.some(p => p.id === r.projectId)) return;
      applyRoute(r);
      setProjectId(id => (id === r.projectId ? id : r.projectId));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [projects]);

  // Keep running/lock badges current without a push channel for the chat list.
  useEffect(() => {
    const t = setInterval(refreshChats, 3000);
    return () => clearInterval(t);
  }, [refreshChats]);

  const project = projects.find(p => p.id === projectId);
  const chat = view.kind === 'chat' ? chats.find(c => c.id === view.chatId) : undefined;
  const openChat = (chatId: number) => { setView({ kind: 'chat', chatId }); setNavOpen(false); };
  const newChat = async (nodes?: NodeRef[]) => {
    if (!project) return;
    try {
      const c = await api.newChat(project.id);
      setChats(cs => [c, ...cs]);
      if (nodes) setHandoff({ chatId: c.id, nodes });
      openChat(c.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className={`app ${chat && !navOpen ? 'chat-open' : ''}`}>
      <aside className="sidebar">
        <Status />

        <label className="label">Project</label>
        <select value={projectId ?? ''} onChange={e => setProjectId(Number(e.target.value))}>
          {projects.length === 0 && <option value="">No projects yet</option>}
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div className="row-between project-actions">
          <button className={`link ${adding === 'new' ? 'active' : ''}`} aria-expanded={adding === 'new'} onClick={() => setAdding(a => (a === 'new' ? null : 'new'))}>+ New project</button>
          <button className={`link ${adding === 'existing' ? 'active' : ''}`} aria-expanded={adding === 'existing'} onClick={() => setAdding(a => (a === 'existing' ? null : 'existing'))}>+ Add existing</button>
        </div>
        {adding === 'existing' && (
          <AddProject
            onCancel={() => setAdding(null)}
            onAdded={p => {
              setProjects(ps => [...ps, p]);
              setProjectId(p.id);
              setAdding(null);
            }}
          />
        )}
        {adding === 'new' && (
          <NewProject
            onCancel={() => setAdding(null)}
            onCreated={(p, chatId, start, err) => {
              // The project exists even if its first turn couldn't start; the chat can be resent.
              if (err) setError(`Project created, but its first turn didn't start: ${err}`);
              // Requirements first: the chat opens with the PRD tab beside it.
              if (start === 'requirements') remember(chatId, { draft: '', ctx: [], tab: 'prd' }, storage());
              setProjects(ps => [...ps, p]);
              viewAfterSwitch.current = { kind: 'chat', chatId };
              setProjectId(p.id);
              setAdding(null);
            }}
          />
        )}

        {project && (
          <>
            <nav className="side-nav">
              <button className={`nav-item ${view.kind === 'map' ? 'active' : ''}`} onClick={() => { setView({ kind: 'map' }); setNavOpen(false); }}>Map</button>
              <button className={`nav-item ${view.kind === 'rules' ? 'active' : ''}`} onClick={() => { setView({ kind: 'rules' }); setNavOpen(false); }}>Project settings</button>
            </nav>
            <div className="row-between">
              <label className="label">Chats</label>
              <button className="small" onClick={() => newChat()}>+ New chat</button>
            </div>
            <nav className="chat-list">
              {chats.map(c => (
                <button
                  key={c.id}
                  className={`chat-item ${view.kind === 'chat' && view.chatId === c.id ? 'active' : ''}`}
                  aria-current={view.kind === 'chat' && view.chatId === c.id ? 'page' : undefined}
                  title={c.title}
                  onClick={() => openChat(c.id)}
                >
                  <span className="chat-title">{c.title}</span>
                  {c.running && <span className="badge run">running</span>}
                  {c.holdsEditLock && <span className="badge lock" title="This chat is changing code; other chats can't edit until it finishes">editing</span>}
                </button>
              ))}
              {chats.length === 0 && <div className="muted side-empty">No chats yet.</div>}
            </nav>
            <div className="path" title={project.path}>{tildify(project.path)}</div>
          </>
        )}
        {error && <div className="error">{error}</div>}
      </aside>

      <main className="main">
        {/* Keyed by screen, so moving elsewhere also clears a crash. */}
        <ErrorBoundary key={view.kind === 'chat' ? `chat:${view.chatId}` : view.kind}>
        {view.kind === 'chat' && chat && project && (
          <ChatView
            key={chat.id} chat={chat} project={project} onChanged={refreshChats}
            initialContext={handoff?.chatId === chat.id ? handoff.nodes : undefined}
            chats={chats} onSwitchChat={openChat} onNewChat={() => newChat()} onShowNav={() => setNavOpen(true)}
          />
        )}
        {view.kind === 'rules' && project && (
          <RulesView key={project.id} project={project} onProjectChanged={p => setProjects(ps => ps.map(x => (x.id === p.id ? p : x)))} />
        )}
        {view.kind === 'map' && project && (
          <MapView
            key={`${project.id}:${mapNavSeq}`}
            project={project}
            initial={mapNav}
            onNav={setMapNav}
            onAskInChat={nodes => newChat(nodes)}
          />
        )}
        {view.kind === 'none' && (
          <div className="empty">
            {project ? 'Open the map, a chat, or start a new chat.' : 'Add a project: a git repository on the box.'}
          </div>
        )}
        </ErrorBoundary>
      </main>
    </div>
  );
}

// Where projects live on this machine: the server's browse root (e.g. ~/dev), which "Add existing"
// starts from, and the folder new projects are created in (FLIGHTDECK_PROJECTS_DIR, inside it).
type Roots = { root: string; newProjectsDir: string };
let rootsPromise: Promise<Roots> | null = null;
function useProjectsRoots(): Roots {
  const [roots, setRoots] = useState<Roots>({ root: '', newProjectsDir: '' });
  useEffect(() => {
    rootsPromise ??= api.browse().then(r => ({ root: r.path, newProjectsDir: r.newProjectsDir })).catch(() => ({ root: '', newProjectsDir: '' }));
    void rootsPromise.then(setRoots);
  }, []);
  return roots;
}

function AddProject({ onAdded, onCancel }: { onAdded: (p: Project) => void; onCancel: () => void }) {
  const { root } = useProjectsRoots();
  const [typed, setPath] = useState<string | null>(null);
  const path = typed ?? (root ? `${root}/` : '');
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
      <input value={path} onChange={e => setPath(e.target.value)} placeholder={root ? `${root}/…` : 'Folder'} />
      <button type="button" className="small" onClick={() => setBrowsing(b => !b)}>{browsing ? 'Close browser' : 'Browse…'}</button>
      {browsing && <FolderBrowser onChoose={p => { setPath(p); setBrowsing(false); }} />}
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Name (defaults to folder)" />
      <div className="form-actions">
        <button type="submit">Add project</button>
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
      </div>
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
      <div className="browser-path" title={at.path}><bdi>{tildify(at.path)}</bdi></div>
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

// A new project starts either from its requirements (a Discuss chat that works out the PRD; no code yet)
// or by scaffolding the stack (a Build chat).
function NewProject({ onCreated, onCancel }: {
  onCreated: (p: Project, chatId: number, start: 'scaffold' | 'requirements', error?: string) => void; onCancel: () => void;
}) {
  const [name, setName] = useState('');
  // The folder follows the name until it's edited by hand.
  const { newProjectsDir } = useProjectsRoots();
  const [path, setPath] = useState<string | null>(null);
  const [start, setStart] = useState<'requirements' | 'scaffold'>('requirements');
  const [stack, setStack] = useState<string>(''); // '' = decide later (requirements first only)
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const folder = path ?? (newProjectsDir ? `${newProjectsDir}/${slug(name)}` : '');
  return (
    <form
      className="add-project"
      onSubmit={async e => {
        e.preventDefault();
        setError('');
        setBusy(true);
        try {
          const r = await api.createProject({ name: name.trim(), path: folder.trim(), start, stack: stack || undefined, description });
          onCreated(r.project, r.chatId, start, r.error);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Name" required />
      <input value={folder} onChange={e => setPath(e.target.value)} placeholder="Folder" />
      <fieldset className="start-choice">
        <legend className="label">Start with</legend>
        <label>
          <input type="radio" name="start" checked={start === 'requirements'} onChange={() => setStart('requirements')} />
          <span><strong>Requirements</strong> <span className="muted">— discuss it and write the PRD first; no code yet</span></span>
        </label>
        <label>
          <input type="radio" name="start" checked={start === 'scaffold'} onChange={() => { setStart('scaffold'); setStack(s => s || STACKS[0].id); }} />
          <span><strong>Scaffold</strong> <span className="muted">— generate the stack now</span></span>
        </label>
      </fieldset>
      <select value={stack} onChange={e => setStack(e.target.value)} aria-label="Stack">
        {start === 'requirements' && <option value="">Stack: decide later</option>}
        {STACKS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
      <textarea
        value={description} onChange={e => setDescription(e.target.value)} rows={3}
        placeholder={start === 'requirements' ? 'What is it for? (optional: with it, Claude starts asking right away)' : 'What is it? (optional, goes to Claude)'}
      />
      <div className="form-actions">
        <button type="submit" disabled={busy || !slug(name) || (start === 'scaffold' && !stack)}>
          {busy ? 'Creating…' : start === 'requirements' ? 'Create and discuss' : 'Create and scaffold'}
        </button>
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
      </div>
      {error && <div className="error">{error}</div>}
    </form>
  );
}

// localStorage can throw (private mode, blocked storage); it only remembers the last project and drafts.
function storage(): Storage | undefined {
  try { return localStorage; } catch { return undefined; }
}
function localStorageGet(k: string) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function localStorageSet(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch { /* not essential */ }
}

// The time, and the plan's usage limits under it — account-wide, from Claude Code's latest turn in
// any project — so a reset time can be read against the clock. A window whose reset has passed says
// so instead of showing old numbers; fresh ones come with the next turn.
function Status() {
  const [now, setNow] = useState(() => Date.now());
  const [limits, setLimits] = useState<z.infer<typeof Limits>>(null);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const load = () => api.limits().then(setLimits, () => {});
    load();
    const poll = setInterval(() => document.visibilityState === 'visible' && load(), 30_000);
    return () => { clearInterval(tick); clearInterval(poll); };
  }, []);
  const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const when = (ms: number) => (new Date(ms).toDateString() === new Date(now).toDateString()
    ? time(ms) : `${new Date(ms).toLocaleDateString([], { weekday: 'short' })} ${time(ms)}`);
  const rows = limitRows(limits?.info);
  return (
    <div className="status">
      <div className="brand">Flightdeck <time className="clock" title={new Date(now).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}>{time(now)}</time></div>
      {rows.length > 0 && (
        <div className="limits" title={`Your plan's usage, as Claude Code reported it at ${time(Date.parse(limits!.at))}. It updates with every turn.`}>
          {rows.map(r => {
            const over = r.resetsAt !== undefined && r.resetsAt * 1000 <= now;
            const tone = over ? 'muted' : r.blocked ? 'bad' : (r.used ?? 0) >= 0.8 ? 'warn-text' : '';
            return (
              <div key={r.label} className={`limit ${tone}`}>
                <span>{r.label}</span>
                {over
                  ? <span>reset at {when(r.resetsAt! * 1000)}</span>
                  : <span>{r.blocked ? 'limit reached' : r.used !== undefined ? `${Math.round(r.used * 100)}% used` : 'ok'}{r.resetsAt ? ` · resets ${when(r.resetsAt * 1000)}` : ''}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// The windows in a rate_limit_event: each with how much is used and when it resets.
function limitRows(info: Record<string, unknown> | undefined): { label: string; used?: number; resetsAt?: number; blocked: boolean }[] {
  if (!info) return [];
  const label = (k: string) => ({ five_hour: '5-hour', seven_day: 'Week' } as Record<string, string>)[k] ?? k.replace(/_/g, ' ');
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const blockedType = info.status !== 'allowed' ? String(info.rateLimitType ?? '') : '';
  const windows = info.unifiedWindows && typeof info.unifiedWindows === 'object' ? Object.entries(info.unifiedWindows as Record<string, Record<string, unknown>>) : [];
  if (windows.length) {
    return windows.map(([k, w]) => ({ label: label(k), used: num(w?.utilization), resetsAt: num(w?.resetsAt), blocked: k === blockedType }));
  }
  return [{ label: label(String(info.rateLimitType ?? 'plan')), resetsAt: num(info.resetsAt), blocked: !!blockedType }];
}
