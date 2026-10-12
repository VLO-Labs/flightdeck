// One chat: the live feed (replayed, then streamed), approval cards and the composer on the left;
// the project workspace on the right — PRD, the maps (attach nodes as context, watch the agent's
// reads and edits light them up) and the code — behind a divider you can drag.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FeedItem, MODELS, type Chat, type CheckResult, type MapNode, type PlanCheck, type MapViewId, type PlanFreshness, type PlanResponse, type ProcessGroup, type Project, type StoredMap } from '../shared/contracts.ts';
import { applyPlan, type PlannedNode } from '../shared/plan.ts';
import { splitCommand } from '../shared/shell.ts';
import { blockedReason, commandMenu, matchCommands, parseCommand, type MenuCommand, type ReportedCommands } from '../shared/commands.ts';
import { actState, derive, groupActivities, groupSummary, str, type Activity, type ActState, type Approval, type Usage } from './feedModel.ts';
import { api } from './api.ts';
import { Crumbs, MapCanvas, nodesForFile, type Heat } from './MapCanvas.tsx';
import { useMap, type NodeRef } from './MapView.tsx';
import { FileViewer } from './FileViewer.tsx';
import { PrdView } from './PrdView.tsx';
import {
  SPLIT_DEFAULT, WORKSPACE_TABS, clampSplit, ctxKey, isMapTab, isNodeRef, isWorkspaceTab, recall, remember, toggleIn,
  type ContextRef, type WorkspaceTab,
} from './workspace.ts';

export function ChatView({ chat, project, onChanged, initialContext, chats, onSwitchChat, onNewChat, onShowNav }: {
  chat: Chat; project: Project; onChanged: () => void; initialContext?: NodeRef[];
  chats: Chat[]; onSwitchChat: (id: number) => void; onNewChat: () => void; onShowNav: () => void;
}) {
  // Picks up where this chat was left: its unsent draft, attached context and workspace tab.
  const [mem] = useState(() => recall(chat.id, storage()));
  const [ctx, setCtx] = useState<ContextRef[]>(() => withContext(mem.ctx, initialContext ?? []));
  // "Review" on a proposal card: the PRD tab opens that proposal.
  const [review, setReview] = useState<{ id: number; seq: number } | null>(null);
  // A map: link in a requirements document: show that node on its map tab.
  const [reveal, setReveal] = useState<{ view: MapViewId; id: string; seq: number } | null>(null);
  const [draft, setDraft] = useState(mem.draft);
  const [tab, setTab] = useState<WorkspaceTab>(() => mem.tab ?? lastTab());
  // The file open in the Code tab ('' = the project's top folder), at a line when one is known.
  const [file, setFile] = useState<{ path: string; line?: number }>(mem.file ?? { path: '' });
  useEffect(() => remember(chat.id, { draft, ctx, tab, file }, storage()), [chat.id, draft, ctx, tab, file]);
  const [showWorkspace, setShowWorkspace] = useState(() => storageGet('fd.chatmap') !== '0');
  // Narrow screens show one panel at a time; this is the one in front there.
  const [panel, setPanel] = useState<'chat' | 'workspace'>('chat');
  const [split, setSplit] = useState(() => Number(storageGet('fd.split')) || SPLIT_DEFAULT);
  const splitBox = useRef<HTMLDivElement>(null);
  const openTab = (t: WorkspaceTab) => {
    setTab(t);
    storageSet('fd.wtab', t);
    setShowWorkspace(true);
    storageSet('fd.chatmap', '1');
    setPanel('workspace');
  };
  const [items, setItems] = useState<FeedItem[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [cur, setCur] = useState(chat); // optimistic copy of the chat's mode/models
  useEffect(() => setCur(chat), [chat]);
  const feed = useRef<HTMLDivElement>(null);
  const feedBody = useRef<HTMLDivElement>(null);
  // Following the bottom, unless the reader scrolled up; then new output only raises a button.
  const stick = useRef(scrollMemory.get(chat.id) == null);
  const restored = useRef(false);
  const [behind, setBehind] = useState(false);
  const seenPlans = useRef<number | null>(null); // plan items seen so far; null until the replay is in

  useEffect(() => {
    setItems([]);
    seenPlans.current = null;
    const es = new EventSource(`/api/chats/${chat.id}/feed`);
    let buffer: FeedItem[] = [];
    let replaying = true;
    es.onopen = () => setConnected(true);
    es.onerror = () => {
      setConnected(false);
      // EventSource reconnects by itself; the server replays everything, so start clean.
      buffer = [];
      replaying = true;
      seenPlans.current = null;
      setItems([]);
    };
    es.addEventListener('replayed', () => {
      replaying = false;
      // What the history already holds isn't news: only plan items arriving after this move the map pane.
      seenPlans.current = buffer.filter(isPlanItem).length;
      setItems(buffer);
    });
    es.onmessage = e => {
      const parsed = FeedItem.safeParse(JSON.parse(e.data));
      if (!parsed.success) return;
      if (replaying) buffer = [...buffer, parsed.data];
      else setItems(xs => [...xs, parsed.data]);
      if (parsed.data.kind === 'run') onChanged();
    };
    return () => es.close();
  }, [chat.id, onChanged]);

  const d = useMemo(() => derive(items, [project.realPath, project.path]), [items, project.realPath, project.path]);
  // The map pane follows the plan: a new version arriving, or a plan card's "Show on map".
  const [planSignal, setPlanSignal] = useState<PlanSignal>({ seq: 0 });
  const planCount = useMemo(() => items.filter(isPlanItem).length, [items]);
  useEffect(() => {
    if (seenPlans.current === null) return; // still replaying
    if (planCount > seenPlans.current) {
      setPlanSignal(p => ({ seq: p.seq + 1 }));
      if (!isMapTab(tab)) setTab('architecture'); // a new plan version is drawn on the maps
    }
    seenPlans.current = planCount;
  }, [planCount]);
  const showPlan = (versionId: number) => {
    openTab(isMapTab(tab) ? tab : 'architecture');
    setPlanSignal(p => ({ versionId, seq: p.seq + 1 }));
  };
  const rows = useMemo(() => groupActivities(d.blocks, d.ended), [d]);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  // A file Claude read or edited opens in the workspace's Code tab (at a line when one is known).
  const openFile = (path: string, line?: number) => { setFile({ path, line }); openTab('code'); };

  // Coming back to a chat puts it where it was left; the first time, at the end.
  useLayoutEffect(() => {
    if (restored.current || items.length === 0 || !feed.current) return;
    restored.current = true;
    const saved = scrollMemory.get(chat.id);
    if (saved != null) feed.current.scrollTop = saved;
    else pinBottom();
  }, [items, chat.id]);

  // Following the bottom means staying there whatever changes size: new output, a card opening, the
  // Running strip or the composer taking room above or below, the column narrowing. Not only when
  // the feed changes: while a card waits for you nothing new arrives, but the strip can still appear.
  const pinBottom = () => { if (feed.current) feed.current.scrollTop = feed.current.scrollHeight; };
  useEffect(() => {
    const ro = new ResizeObserver(() => { if (stick.current) pinBottom(); });
    if (feed.current) ro.observe(feed.current);
    if (feedBody.current) ro.observe(feedBody.current);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (restored.current && !stick.current) setBehind(true);
  }, [d]);
  const toBottom = () => {
    stick.current = true;
    setBehind(false);
    scrollMemory.delete(chat.id);
    pinBottom();
  };

  // Slash commands: what Claude Code said it has (this chat's latest turn, else the project's), a
  // menu while the first word is being typed, and a word on the ones Flightdeck won't send.
  const [projectCommands, setProjectCommands] = useState<ReportedCommands | null>(null);
  useEffect(() => { api.commands(project.id).then(setProjectCommands, () => {}); }, [project.id]);
  const reported = d.commands ?? projectCommands ?? undefined;
  const menu = useMemo(() => commandMenu(reported), [reported]);
  const typedCommand = /^\/(\S*)$/.exec(draft)?.[1];
  const [menuDismissed, setMenuDismissed] = useState<string | null>(null);
  const matches = typedCommand !== undefined && draft !== menuDismissed ? matchCommands(menu, typedCommand) : [];
  const [pick, setPick] = useState(0);
  useEffect(() => setPick(0), [typedCommand]);
  const command = parseCommand(draft);
  const blocked = command ? blockedReason(command.name, reported) : undefined;
  const choose = (m: MenuCommand) => setDraft(`/${m.name} `);

  const send = async () => {
    const text = draft.trim();
    if (!text || d.running || blocked) return;
    setError('');
    try {
      // A command goes on its own; what's attached waits for the next message.
      await api.send(chat.id, text, command ? [] : ctx.map(c => (isNodeRef(c) ? { view: c.view, nodeId: c.nodeId } : { doc: c.doc, ref: c.ref })));
      setDraft('');
      if (!command) setCtx([]);
      toBottom();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const rel = (p: unknown) => {
    if (typeof p !== 'string') return str(p);
    for (const r of [project.realPath, project.path]) if (p.startsWith(r + '/')) return p.slice(r.length + 1);
    return p;
  };
  const toggleCtx = (c: ContextRef) => setCtx(cs => toggleIn(cs, c));

  return (
    <div
      ref={splitBox}
      className={`chat-split ${showWorkspace ? 'with-workspace' : ''} front-${panel}`}
      style={{ '--split': `${split}%` } as CSSProperties}
    >
    <div className={`chat mode-${cur.mode}`}>
      <header className="chat-header">
        <ChatPicker chat={chat} chats={chats} onSwitch={onSwitchChat} onNew={onNewChat} onShowNav={onShowNav} />
        <div className="chat-meta">
          <div className="mode-toggle" role="radiogroup" aria-label="Mode" title="Discuss: read, analyze, plan — edits are refused. Build: may change code.">
            {(['discuss', 'build'] as const).map(m => (
              <button
                key={m}
                role="radio"
                aria-checked={cur.mode === m}
                className={cur.mode === m ? `on ${m}` : ''}
                disabled={d.running}
                onClick={async () => {
                  if (cur.mode === m) return;
                  setError('');
                  try { setCur(await api.chatSettings(chat.id, { mode: m })); } catch (e) { setError((e as Error).message); }
                }}
              >
                {m === 'discuss' ? 'Discuss' : 'Build'}
              </button>
            ))}
          </div>
          <ModelPicker chat={cur} project={project} disabled={d.running} onChange={async (field, value) => {
            setError('');
            try { setCur(await api.chatSettings(chat.id, { [field]: value })); } catch (e) { setError((e as Error).message); }
          }} />
          {d.usage && <UsageBadge u={d.usage} />}
          {!connected && <span className="badge bad">reconnecting…</span>}
          <button
            className={`small wide-only ${showWorkspace ? '' : 'ghost'}`}
            aria-pressed={showWorkspace}
            onClick={() => setShowWorkspace(v => { storageSet('fd.chatmap', v ? '0' : '1'); return !v; })}
          >
            {showWorkspace ? 'Hide workspace' : 'Show workspace'}
          </button>
          <button className="small narrow-only" onClick={() => openTab(tab)}>Workspace →</button>
        </div>
      </header>
      <RunningStrip project={project} turnRunning={d.running} />

      <div className="feed-wrap">
      <div
        className="feed"
        ref={feed}
        onScroll={e => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          if (stick.current) { setBehind(false); scrollMemory.delete(chat.id); }
          else scrollMemory.set(chat.id, el.scrollTop);
        }}
      >
      <div className="feed-body" ref={feedBody}>
        {items.length === 0 && (
          <div className="feed-empty muted">
            {connected
              ? <>Ask about the code, plan a change, or say what to build. Click boxes on the workspace's maps, or requirements in the PRD, to attach them as context. {cur.mode === 'discuss' ? 'This chat is in Discuss, so nothing gets edited until you switch it to Build.' : ''}</>
              : 'Loading…'}
          </div>
        )}
        {rows.map(r => {
          if (r.kind === 'group') {
            const open = openGroups.has(r.key);
            return (
              <div key={r.key} className="activity-group">
                <button className="activity-group-head" onClick={() => setOpenGroups(s => toggled(s, r.key))} aria-expanded={open}>
                  <span className="caret">{open ? '▾' : '▸'}</span>
                  <span>{r.items.length} steps</span>
                  <span className="muted">{groupSummary(r.items, d.ended)}</span>
                </button>
                {open && r.items.map(a => <ActivityLine key={a.key} a={a} state={actState(a, d.ended)} rel={rel} onOpenFile={openFile} mode={cur.mode} />)}
              </div>
            );
          }
          const b = r.block;
          switch (b.kind) {
            case 'user':
              return (
                <div key={b.key} className="msg user">
                  <div className="msg-head">You{b.tag && <span className="muted"> · {b.tag}</span>}</div>
                  {b.context && <div className="chips">{b.context.map(l => <span key={l} className="chip">{l}</span>)}</div>}
                  <div className="msg-text">{b.text}</div>
                </div>
              );
            case 'text':
              return <div key={b.key} className="msg assistant md"><Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{b.text}</Markdown></div>;
            case 'note':
              return <div key={b.key} className={`note ${b.tone}`}>{b.text}</div>;
            case 'approval':
              return <ApprovalCard key={b.key} a={b.approval} rel={rel} mode={cur.mode} />;
            case 'activity':
              return <ActivityLine key={b.key} a={b} state={actState(b, d.ended)} rel={rel} onOpenFile={openFile} mode={cur.mode} />;
            case 'check':
              return (
                <div key={b.key} className="plan-card">
                  <span className="plan-card-v">Check of plan v{b.version}</span>
                  {b.failed
                    ? <span className="error">{b.failed}</span>
                    : <span>{(['verified', 'missing', 'review', 'unexpected'] as const).filter(k => b.counts[k]).map(k => (
                        <span key={k} className={`check-tag ${k}`}>{b.counts[k]} {CHECK_LABEL[k]}</span>
                      ))}</span>}
                  <button className="small" onClick={() => (b.versionId ? showPlan(b.versionId) : openTab(isMapTab(tab) ? tab : 'architecture'))}>Show on map</button>
                </div>
              );
            case 'req-proposal':
              return (
                <div key={b.key} className="plan-card req-card">
                  <span className="plan-card-v">Requirements edit #{b.proposalId}</span>
                  <span className="mono muted">{b.path}</span>
                  <span className="req-card-summary">{b.summary}</span>
                  <button className="small" onClick={() => { setReview(r => ({ id: b.proposalId, seq: (r?.seq ?? 0) + 1 })); openTab('prd'); }}>Review</button>
                </div>
              );
            case 'plan':
              return (
                <div key={b.key} className="plan-card">
                  <span className="plan-card-v">Plan v{b.version}</span>
                  <span className="plan-card-title">{b.title}</span>
                  <span className="muted">
                    {b.counts.added > 0 && <span className="plan-tag added">+{b.counts.added}</span>}{' '}
                    {b.counts.changed > 0 && <span className="plan-tag changed">~{b.counts.changed}</span>}{' '}
                    {b.counts.removed > 0 && <span className="plan-tag removed">−{b.counts.removed}</span>}
                  </span>
                  <button className="small" onClick={() => showPlan(b.versionId)}>Show on map</button>
                </div>
              );
          }
        })}
        {d.partial && <div className="msg assistant partial"><Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{d.partial}</Markdown></div>}
        {d.running && !d.partial && <div className="note muted working">Working…</div>}
      </div>
      </div>
      {behind && <button className="small new-below" onClick={toBottom}>New activity ↓</button>}
      </div>

      <footer className="composer">
        <div className="mode-line">
          {cur.mode === 'build'
            ? <><strong>Build</strong> — Claude may change files in this project (as your rules allow). Requirements go as their approved version.</>
            : <><strong>Discuss</strong> — read-only: Claude reads and proposes; edits are refused.</>}
        </div>
        {error && <div className="error">{error}</div>}
        {blocked && <div className="error">/{command!.name} isn’t available here. {blocked}</div>}
        {command && !blocked && ctx.length > 0 && <div className="muted composer-hint">A command goes on its own — the attachments stay for your next message.</div>}
        {matches.length > 0 && (
          <div className="cmd-menu" role="listbox" aria-label="Claude Code commands">
            {matches.map((m, i) => (
              <button
                key={m.name} role="option" aria-selected={i === pick} className={i === pick ? 'on' : ''}
                ref={i === pick ? el => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                onMouseDown={e => { e.preventDefault(); choose(m); }} onMouseEnter={() => setPick(i)}
              >
                <span className="mono">/{m.name}</span>
                <span className="muted">{m.description ?? 'skill'}</span>
              </button>
            ))}
          </div>
        )}
        {ctx.length > 0 && (
          <div className="chips composer-chips">
            {ctx.map(c => (
              <span key={ctxKey(c)} className={`chip ${isNodeRef(c) ? '' : 'req'}`} title={isNodeRef(c) ? `${c.view} map` : c.doc}>
                {c.label}
                <button className="chip-x" title="Remove" onClick={() => toggleCtx(c)}>×</button>
              </span>
            ))}
          </div>
        )}
        <textarea
          value={draft}
          placeholder={d.running ? 'Claude is working — stop it or wait for it to finish' : 'Message Claude Code (Enter to send, Shift+Enter for a new line, / for commands)'}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (matches.length > 0) {
              const m = matches[pick] ?? matches[0]!;
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setPick(p => (p + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
                return;
              }
              if (e.key === 'Escape') { e.preventDefault(); setMenuDismissed(draft); return; }
              // Enter on a name already typed in full sends it; otherwise it completes the name.
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && m.name !== typedCommand)) {
                e.preventDefault();
                choose(m);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={3}
        />
        {d.running
          ? <button className="stop" onClick={() => api.stop(chat.id)}>Stop</button>
          : <button onClick={send} disabled={!draft.trim() || !!blocked}>Send</button>}
      </footer>
    </div>
    {showWorkspace && (
      <>
        <SplitHandle box={splitBox} split={split} onSplit={setSplit} />
        <section className="workspace" aria-label="Workspace">
          <div className="ws-tabs">
            <button className="small ghost narrow-only" onClick={() => setPanel('chat')}>← Chat</button>
            <div role="tablist" aria-label="Workspace views" className="ws-tablist" onKeyDown={e => {
              // Arrow keys move between tabs, as in any tab list.
              const i = WORKSPACE_TABS.findIndex(t => t.id === tab);
              const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
              if (!step) return;
              e.preventDefault();
              const next = WORKSPACE_TABS[(i + step + WORKSPACE_TABS.length) % WORKSPACE_TABS.length]!;
              openTab(next.id);
              (e.currentTarget.querySelector(`[data-tab="${next.id}"]`) as HTMLElement | null)?.focus();
            }}>
              {WORKSPACE_TABS.map(t => (
                <button
                  key={t.id} role="tab" data-tab={t.id} aria-selected={tab === t.id} tabIndex={tab === t.id ? 0 : -1}
                  className={tab === t.id ? 'on' : ''} onClick={() => openTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <div className="ws-body" role="tabpanel">
            {tab === 'prd' && (
              <PrdView
                project={project} ctx={ctx} onToggle={toggleCtx} review={review} onOpenFile={openFile}
                onRevealNode={(view, id) => { setReveal(r => ({ view, id, seq: (r?.seq ?? 0) + 1 })); openTab(view); }}
              />
            )}
            {isMapTab(tab) && <ChatMapPane chat={chat} project={project} view={tab} ctx={ctx} onToggle={toggleCtx} touched={d.touched} live={d.running} planSignal={planSignal} reveal={reveal} />}
            {tab === 'code' && (
              <FileViewer
                inline project={project} path={file.path} line={file.line}
                onOpen={p => setFile({ path: p })} onClose={() => setFile({ path: '' })}
              />
            )}
          </div>
        </section>
      </>
    )}
    </div>
  );
}

const isPlanItem = (i: FeedItem) => i.kind === 'plan' || i.kind === 'plan-dropped';

// Where each chat was left, per chat id; absent = following the end. Lives for the page's lifetime.
const scrollMemory = new Map<number, number>();

const toggled = (s: Set<string>, k: string) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; };

// The map beside the chat: click a node to attach it to the next message; nodes light up as the
// latest run reads (blue) or edits (amber) the files behind them. With a plan, the Plan layer draws
// it over the current map (PLAN.md §10); the map files themselves are never touched.
export type PlanSignal = { versionId?: number; seq: number }; // "show this version" / "a new one arrived"

function ChatMapPane({ chat, project, view, ctx, onToggle, touched, live, planSignal, reveal }: {
  chat: Chat; project: Project; view: MapViewId; ctx: ContextRef[]; onToggle: (n: NodeRef) => void; touched: Map<string, Heat>; live: boolean;
  planSignal: PlanSignal; reveal: { view: MapViewId; id: string; seq: number } | null;
}) {
  const { data } = useMap(project.id, view);
  const [path, setPath] = useState<string[]>([]);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [versionId, setVersionId] = useState<number | undefined>();
  const [layer, setLayer] = useState<'current' | 'plan'>('current');
  const [filter, setFilter] = useState<'all' | 'changes'>('all');
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => { setPath([]); setPicked(null); }, [view, layer, filter]);

  // A plan card's "Show on map" picks its version; a new version arriving shows the latest.
  useEffect(() => {
    setVersionId(planSignal.versionId);
    if (planSignal.seq > 0) setLayer('plan');
  }, [planSignal.seq]);
  useEffect(() => {
    let gone = false;
    api.plan(chat.id, versionId).then(p => {
      if (gone) return;
      setPlan(p);
      // The first look at a chat with a live plan shows it.
      if (planSignal.seq === 0 && p.plan && (p.plan.status === 'draft' || p.plan.status === 'approved')) setLayer('plan');
    }).catch(() => {});
    return () => { gone = true; };
  }, [chat.id, versionId, planSignal.seq]);
  const checking = plan?.check?.status === 'running';
  useEffect(() => {
    if (!checking) return;
    const t = setInterval(() => api.plan(chat.id, versionId).then(setPlan).catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [checking, chat.id, versionId]);

  const map = data?.map ?? null;
  const version = plan?.version ?? null;
  // A link asked to see a node: open the level that holds it, select it and bring it into view.
  const revealed = useRef(0);
  const [focus, setFocus] = useState<{ id: string; seq: number } | null>(null);
  useEffect(() => {
    if (!reveal || reveal.view !== view || reveal.seq === revealed.current || !map) return;
    revealed.current = reveal.seq;
    const byId = new Map(map.nodes.map(n => [n.id, n]));
    const node = byId.get(reveal.id);
    if (!node) return;
    const at: string[] = [];
    for (let p = node.parent ? byId.get(node.parent) : undefined; p; p = p.parent ? byId.get(p.parent) : undefined) at.unshift(p.id);
    setLayer('current');
    setPath(at);
    setPicked(node.id);
    setFocus({ id: node.id, seq: reveal.seq });
  }, [reveal?.seq, view, map]);
  const onPlan = layer === 'plan' && version !== null;
  // Results on the cards, when looking at the version that was checked.
  const checks = useMemo(() => {
    const c = plan?.check;
    if (!c || c.status !== 'done' || c.versionId !== version?.id) return undefined;
    return new Map(c.items.filter(i => i.view === view && i.kind === 'node').map(i => [i.id, i.result]));
  }, [plan, version, view]);

  // The plan laid over this view's map; with "Changes only", just what changes and the parts that
  // lead to it (ancestors, the other ends of changed edges).
  const shown = useMemo(() => {
    if (!onPlan) return map;
    const pm = applyPlan(map, version!.body.changes[view]);
    let { nodes, edges } = pm;
    if (filter === 'changes') {
      const byId = new Map(nodes.map(n => [n.id, n]));
      const keep = new Set<string>();
      const withAncestors = (id: string) => { for (let n = byId.get(id); n; n = n.parent ? byId.get(n.parent) : undefined) keep.add(n.id); };
      for (const n of nodes) if (n.status) withAncestors(n.id);
      for (const e of edges) if (e.status) { withAncestors(e.from); withAncestors(e.to); }
      nodes = nodes.filter(n => keep.has(n.id));
      edges = edges.filter(e => e.status);
    }
    const base: StoredMap = map ?? { version: 1, view, generatedAt: 'none', commit: null, model: '', warnings: [], nodes: [], edges: [] };
    // A distinct identity per version and filter, so the canvas lays it out afresh.
    return { ...base, generatedAt: `${base.generatedAt}|plan-${version!.id}|${filter}`, nodes, edges };
  }, [onPlan, map, version, view, filter]);

  const stale = useMemo(() => new Set(onPlan ? [] : data?.staleNodeIds ?? []), [data, onPlan]);
  const inContext = useMemo(() => new Set(ctx.filter(isNodeRef).filter(c => c.view === view).map(c => c.nodeId)), [ctx, view]);
  const heat = useMemo(() => {
    const out = new Map<string, Heat>();
    if (!shown) return out;
    for (const [rel, h] of touched) {
      for (const id of nodesForFile(shown, rel)) if (out.get(id) !== 'edit') out.set(id, h);
    }
    return out;
  }, [shown, touched]);
  const pickedNode = picked ? (shown?.nodes.find(n => n.id === picked) as PlannedNode | undefined) : undefined;

  return (
    <div className="chat-map">
      <div className="chat-map-head">
        {version && (
          <div className="mode-toggle" role="radiogroup" aria-label="Layer">
            {(['current', 'plan'] as const).map(l => (
              <button key={l} role="radio" aria-checked={layer === l} className={layer === l ? 'on' : ''} onClick={() => setLayer(l)}>
                {l === 'current' ? 'Current' : 'Plan'}
              </button>
            ))}
          </div>
        )}
        <span className="muted chat-map-legend">
          {onPlan
            ? <><span className="plan-tag added">new</span> <span className="plan-tag changed">changed</span> <span className="plan-tag removed">removed</span></>
            : <>{touched.size > 0 ? (live ? 'This run: ' : 'Last run: ') : ''}<span className="heat-tag read">read</span> <span className="heat-tag edit">edited</span></>}
        </span>
      </div>
      {onPlan && plan && version && (
        <PlanBar
          chat={chat} plan={plan} version={version} filter={filter} onFilter={setFilter} onVersion={setVersionId}
          picked={pickedNode} view={view} busy={live}
          onChanged={p => { setPlan(p); if (p.version) setVersionId(p.version.id); }}
        />
      )}
      {shown && shown.nodes.length > 0 && <Crumbs map={shown} root={project.name} path={path} onPath={setPath} />}
      <div className="chat-map-canvas">
        {shown && shown.nodes.length > 0
          ? <MapCanvas
              map={shown} view={view} stale={stale} path={path} onPath={setPath} inContext={inContext} heat={heat} plan={onPlan} checks={checks}
              selected={picked} focus={focus}
              // A narrow side pane, used to pick nodes: an overview matters more than full-size text.
              minFitZoom={0.35}
              onSelect={id => {
                const n = id ? shown.nodes.find(x => x.id === id) : undefined;
                setPicked(n?.id ?? null);
                if (n) onToggle({ view, nodeId: n.id, label: n.label });
              }}
            />
          : <div className="empty muted">
              {onPlan ? `This plan doesn't change the ${view} view.` : `No ${view} map yet — make one from the project's Map screen.`}
            </div>}
      </div>
      <div className="chat-map-foot muted">Click a node to attach it to your message · double-click to open it</div>
    </div>
  );
}

// The divider between chat and workspace: drag it, or focus it and use the arrow keys; a
// double-click puts it back. The chat's share is kept across chats and reloads.
function SplitHandle({ box, split, onSplit }: { box: RefObject<HTMLDivElement | null>; split: number; onSplit: (pct: number) => void }) {
  const set = (pct: number) => {
    const w = box.current?.getBoundingClientRect().width ?? 0;
    const v = clampSplit(pct, w);
    onSplit(v);
    return v;
  };
  const save = (v: number) => storageSet('fd.split', String(v));
  return (
    <div
      className="split-handle wide-only" role="separator" aria-orientation="vertical" aria-label="Resize chat and workspace"
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(split)} tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={e => {
        const rect = box.current?.getBoundingClientRect();
        if (!rect) return;
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        document.body.classList.add('resizing');
        let last = split;
        const move = (ev: PointerEvent) => { last = set(((ev.clientX - rect.left) / rect.width) * 100); };
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
          document.body.classList.remove('resizing');
          save(last);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      }}
      onDoubleClick={() => save(set(SPLIT_DEFAULT))}
      onKeyDown={e => {
        const step = e.key === 'ArrowLeft' ? -2 : e.key === 'ArrowRight' ? 2 : 0;
        if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); save(set(e.key === 'Home' ? 0 : 100)); return; }
        if (!step) return;
        e.preventDefault();
        save(set(split + step));
      }}
    />
  );
}

// The chat's name, and the menu to switch to another chat of this project or start one: there on
// every screen size, so chats stay reachable when the sidebar is out of sight.
function ChatPicker({ chat, chats, onSwitch, onNew, onShowNav }: {
  chat: Chat; chats: Chat[]; onSwitch: (id: number) => void; onNew: () => void; onShowNav: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); root.current?.querySelector('button')?.focus(); } };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const pick = (f: () => void) => { setOpen(false); f(); };
  return (
    <div className="chat-picker" ref={root}>
      <button className="chat-picker-button" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(o => !o)} title={chat.title}>
        <span className="chat-name">{chat.title}</span>
        <span className="muted" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="chat-picker-menu" role="menu" aria-label="Chats">
          <button role="menuitem" className="chat-item" onClick={() => pick(onNew)}>+ New chat</button>
          <div className="chat-picker-list">
            {chats.map(c => (
              <button
                key={c.id} role="menuitem" className={`chat-item ${c.id === chat.id ? 'active' : ''}`}
                aria-current={c.id === chat.id ? 'page' : undefined} title={c.title}
                onClick={() => pick(() => onSwitch(c.id))}
              >
                <span className="chat-title">{c.title}</span>
                {c.running && <span className="badge run">running</span>}
                {c.holdsEditLock && <span className="badge lock">editing</span>}
              </button>
            ))}
          </div>
          <button role="menuitem" className="chat-item narrow-only muted" onClick={() => pick(onShowNav)}>Projects, map and settings…</button>
        </div>
      )}
    </div>
  );
}

const withContext = (have: ContextRef[], add: ContextRef[]) => [...have, ...add.filter(n => !have.some(c => ctxKey(c) === ctxKey(n)))];
const lastTab = (): WorkspaceTab => { const t = storageGet('fd.wtab'); return isWorkspaceTab(t) ? t : 'architecture'; };
// localStorage itself can throw on access (blocked storage); the memory then lasts the page only.
function storage(): Storage | undefined {
  try { return localStorage; } catch { return undefined; }
}

const FRESHNESS: Record<PlanFreshness['state'], { label: string; tone: string; title: string }> = {
  fresh: { label: 'matches the code', tone: '', title: 'Nothing changed since this version was made.' },
  elsewhere: { label: 'code changed elsewhere', tone: '', title: 'Files changed since this version, but none the plan works in.' },
  stale: { label: 'out of date', tone: 'warn', title: 'Files the plan works in changed since this version; revalidate it or ask for a revision.' },
  'map-regenerated': { label: 'map regenerated', tone: 'warn', title: 'A map this plan builds on was regenerated; revalidate it against the new one.' },
};

// The plan's header in the map pane: which version, how current it is, the filter, and its text.
function PlanBar({ chat, plan, version, filter, onFilter, onVersion, picked, view, busy, onChanged }: {
  chat: Chat; plan: PlanResponse; version: NonNullable<PlanResponse['version']>; filter: 'all' | 'changes';
  onFilter: (f: 'all' | 'changes') => void; onVersion: (id: number) => void; picked?: PlannedNode; view: MapViewId;
  busy: boolean; onChanged: (p: PlanResponse) => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const act = async (f: () => Promise<PlanResponse>) => {
    setError('');
    try { onChanged(await f()); } catch (e) { setError((e as Error).message); }
  };
  const live = plan.plan?.status === 'draft' || plan.plan?.status === 'approved';
  // Freshness is about drafts: once a version is approved, Build is meant to change the code and the
  // check regenerates the maps, so drift is expected there, not a warning.
  const isApproved = version.id === plan.plan?.approvedVersionId;
  const needsRevalidation = !isApproved && (version.freshness.state === 'stale' || version.freshness.state === 'map-regenerated');
  const f = FRESHNESS[version.freshness.state];
  const approvedId = plan.plan?.approvedVersionId ?? null;
  // Dropping keeps the record of what was approved, so "dropped" has to win over it.
  const dropped = plan.plan?.status === 'dropped';
  const status = dropped ? 'dropped' : version.id === approvedId ? 'approved' : version.approvedAt ? 'approved earlier' : 'draft';
  const freshTitle = f.title + (version.freshness.touched.length ? `\n${version.freshness.touched.slice(0, 12).join('\n')}` : '')
    + (version.freshness.baseMissing ? '\nThe commit it was made on is gone (rebase or reset).' : '');
  return (
    <div className="plan-bar">
      <div className="plan-bar-row">
        <select value={version.id} onChange={e => onVersion(Number(e.target.value))} aria-label="Plan version">
          {plan.versions.map(v => (
            <option key={v.id} value={v.id}>
              v{v.version}{v.source === 'revalidated' ? ' (revalidated)' : ''}{v.id === approvedId ? (dropped ? ' · was approved' : ' · approved') : ''}
            </option>
          ))}
        </select>
        <span className={`badge ${status === 'approved' ? 'run' : ''}`}>{status}</span>
        {!isApproved && <span className={`badge ${f.tone}`} title={freshTitle}>{f.label}</span>}
        <div className="mode-toggle" role="radiogroup" aria-label="Show">
          {(['all', 'changes'] as const).map(x => (
            <button key={x} role="radio" aria-checked={filter === x} className={filter === x ? 'on' : ''} onClick={() => onFilter(x)}>
              {x === 'all' ? 'All' : 'Changes only'}
            </button>
          ))}
        </div>
        <button className="link" onClick={() => setOpen(o => !o)} aria-expanded={open}>{open ? 'Hide details' : 'Details'}</button>
      </div>
      {live && (
        <div className="plan-bar-row">
          {version.id !== plan.plan?.approvedVersionId && (
            <button
              className="small" disabled={busy || needsRevalidation}
              title={needsRevalidation ? 'Revalidate it first: the code or maps changed since this version.' : 'Freeze this version as what Build implements.'}
              onClick={() => act(() => api.approvePlan(chat.id, version.id))}
            >
              Approve v{version.version}
            </button>
          )}
          {needsRevalidation && (
            <button className="small ghost" disabled={busy} title="Check it against today's code and maps; saved as a new version."
              onClick={() => act(() => api.revalidatePlan(chat.id, version.id))}>
              Revalidate
            </button>
          )}
          {version.id === plan.plan?.approvedVersionId && (
            <button
              className="small" disabled={busy || plan.check?.status === 'running'}
              title="Regenerates the maps this plan touches, then compares them, the git changes and the files with the plan."
              onClick={() => act(() => api.checkPlan(chat.id))}
            >
              {plan.check ? 'Check again' : 'Check against plan'}
            </button>
          )}
          <button className="small ghost" disabled={busy} onClick={() => act(() => api.dropPlan(chat.id))}>Drop plan</button>
          {plan.plan?.approvedVersionId !== null && plan.plan?.approvedVersionId !== undefined && (
            <span className="muted">
              Build implements v{plan.versions.find(v => v.id === plan.plan!.approvedVersionId)?.version}
              {version.id !== plan.plan.approvedVersionId ? ' until you approve another version' : ''}.
            </span>
          )}
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {plan.check && version.id === plan.check.versionId && <CheckSummary check={plan.check} />}
      <div className="plan-title">{version.body.title}</div>
      {picked?.status && (
        <div className="plan-picked">
          <span className={`plan-tag ${picked.status}`}>{picked.status === 'added' ? 'new' : picked.status}</span>{' '}
          <strong>{picked.label}</strong>{picked.why ? ` — ${picked.why}` : ''}
          {picked.before && <PlanBefore before={picked.before} after={picked} />}
        </div>
      )}
      {open && (
        <div className="plan-details">
          <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{version.body.summary}</Markdown>
          {version.body.steps.length > 0 && (
            <>
              <div className="plan-h">Build steps</div>
              <ol>{version.body.steps.map((s, i) => <li key={i}>{s.text}</li>)}</ol>
            </>
          )}
          {version.body.questions.length > 0 && (
            <>
              <div className="plan-h">Open questions</div>
              <ul>{version.body.questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
            </>
          )}
          {version.warnings.map(w => <div key={w} className="muted">⚠ {w}</div>)}
          {!version.body.changes[view] && <div className="muted">Nothing changes in this view.</div>}
        </div>
      )}
    </div>
  );
}

const CHECK_LABEL: Record<CheckResult, string> = { verified: 'verified', missing: 'missing', review: 'need review', unexpected: 'unexpected' };

// The result of checking what was built against the approved version: counts, then each item with
// the evidence its result rests on.
function CheckSummary({ check }: { check: PlanCheck }) {
  const [open, setOpen] = useState<CheckResult | null>(null);
  if (check.status === 'running') return <div className="muted">Checking… {check.progress}</div>;
  if (check.status === 'failed') return <div className="error">Check failed: {check.error}</div>;
  const order = ['missing', 'review', 'unexpected', 'verified'] as const;
  return (
    <div className="check-summary">
      <div className="plan-bar-row">
        <span className="muted">Checked {new Date(check.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}:</span>
        {order.filter(k => check.counts[k]).map(k => (
          <button key={k} className={`link check-tag ${k}`} onClick={() => setOpen(o => (o === k ? null : k))} aria-expanded={open === k}>
            {check.counts[k]} {CHECK_LABEL[k]}
          </button>
        ))}
        {check.tests.length > 0 && (
          <span className="muted" title={check.tests.map(t => `${t.ok ? '✓' : '✗'} ${t.command}`).join('\n')}>
            · tests in Build: {check.tests.filter(t => t.ok).length}/{check.tests.length} passed
          </span>
        )}
        {check.tests.length === 0 && <span className="muted">· no test runs seen in Build</span>}
      </div>
      {open && (
        <ul className="check-items">
          {check.items.filter(i => i.result === open).map(i => (
            <li key={`${i.view}:${i.kind}:${i.id}`}>
              <strong>{i.label}</strong>
              <span className="muted"> {i.kind === 'file' ? 'file' : `${i.change === 'none' ? '' : i.change + ' '}${i.kind}${i.view ? ` · ${i.view}` : ''}`}</span>
              {i.evidence.length > 0 && <ul>{i.evidence.map(e => <li key={e} className="muted">{e}</li>)}</ul>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// What a changed node was before: only the fields that differ.
function PlanBefore({ before, after }: { before: MapNode; after: MapNode }) {
  const rows: [string, string][] = (['label', 'kind', 'summary'] as const).filter(k => before[k] !== after[k]).map(k => [k, before[k]]);
  if (before.files.join() !== after.files.join()) rows.push(['files', before.files.join(', ')]);
  if (rows.length === 0) return null;
  return <div className="plan-before muted">Was: {rows.map(([k, v]) => <span key={k}>{k} “{v}” </span>)}</div>;
}

function storageGet(k: string) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function storageSet(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch { /* not essential */ }
}

function summary(name: string, input: Record<string, unknown>, rel: (p: unknown) => string): string {
  switch (name) {
    case 'Bash': return `$ ${str(input.command)}`;
    case 'Read': case 'Edit': case 'Write': case 'MultiEdit': return `${name} ${rel(input.file_path)}`;
    case 'NotebookEdit': return `${name} ${rel(input.notebook_path)}`;
    case 'Grep': return `Search “${str(input.pattern)}”${input.path ? ` in ${rel(input.path)}` : ''}`;
    case 'Glob': return `Find ${str(input.pattern)}`;
    case 'WebFetch': return `Fetch ${str(input.url)}`;
    case 'WebSearch': return `Search the web: ${str(input.query)}`;
    case 'Task': case 'Agent': return `Subagent: ${str(input.description)}`;
    case 'TodoWrite': return 'Update plan';
    default: return name;
  }
}

const STATE_LABEL: Record<ActState, string> = {
  running: 'running', waiting: 'needs approval', done: '', failed: 'failed', denied: 'denied', cancelled: 'cancelled',
};
const RESULT_MAX = 20_000;

function ActivityLine({ a, state, rel, onOpenFile, mode }: {
  a: Activity; state: ActState; rel: (p: unknown) => string; onOpenFile: (path: string, line?: number) => void; mode: string;
}) {
  const [open, setOpen] = useState(false);
  const ap = a.approval;
  // A file inside the project can be opened in the viewer; Read gives the line it started at.
  const filePath = a.input.file_path ?? a.input.notebook_path;
  const relFile = typeof filePath === 'string' ? rel(filePath) : undefined;
  const openable = relFile !== undefined && relFile !== filePath;
  const line = a.name === 'Read' && typeof a.input.offset === 'number' ? a.input.offset : undefined;
  return (
    <div className={`activity st-${state}`}>
      <div className="activity-line" role="button" tabIndex={0} aria-expanded={open}
        onClick={() => setOpen(o => !o)} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setOpen(o => !o))}>
        <span className="dot" />
        <span className="activity-text">
          {openable
            ? <>{a.name} <button className="link file-ref" onClick={e => { e.stopPropagation(); onOpenFile(relFile!, line); }}>{relFile}</button></>
            : summary(a.name, a.input, rel)}
        </span>
        {typeof a.input.description === 'string' && a.name === 'Bash' && <span className="activity-desc">{a.input.description}</span>}
        {STATE_LABEL[state] && <span className={`state-tag st-${state}`}>{STATE_LABEL[state]}</span>}
      </div>
      {ap && ap.state === 'pending' && <ApprovalCard a={ap} rel={rel} inline mode={mode} />}
      {ap && ap.state !== 'pending' && (ap.decidedBy !== 'rule' || ap.state === 'denied') && (
        <div className={`decided ${ap.state}`}>{decidedText(ap)}</div>
      )}
      {open && (
        <div className="activity-detail">
          <ToolInput name={a.name} input={a.input} rel={rel} />
          {a.result && (
            <pre className={`tool-result ${a.result.isError ? 'bad' : ''}`}>
              {a.result.text.slice(0, RESULT_MAX)}
              {a.result.text.length > RESULT_MAX && `\n… ${(a.result.text.length - RESULT_MAX).toLocaleString()} more characters`}
            </pre>
          )}
          {!a.result && state === 'cancelled' && <div className="muted">No result: the turn ended before this finished.</div>}
        </div>
      )}
    </div>
  );
}

// A tool's input, shown the way it reads best: a command as a command, an edit as before/after.
function ToolInput({ name, input, rel }: { name: string; input: Record<string, unknown>; rel: (p: unknown) => string }) {
  if (name === 'Bash' && typeof input.command === 'string') return <pre className="tool-cmd">$ {input.command}</pre>;
  if (name === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    return (
      <div className="tool-edit">
        <div className="muted">{rel(input.file_path)}{input.replace_all ? ' · every occurrence' : ''}</div>
        <pre className="diff">
          {input.old_string.split('\n').map((l, i) => <div key={`o${i}`} className="del">- {l}</div>)}
          {input.new_string.split('\n').map((l, i) => <div key={`n${i}`} className="add">+ {l}</div>)}
        </pre>
      </div>
    );
  }
  if (name === 'Write' && typeof input.content === 'string') {
    const lines = input.content.split('\n');
    return (
      <div className="tool-edit">
        <div className="muted">{rel(input.file_path)} · {lines.length} lines</div>
        <pre className="diff">{lines.slice(0, 80).map((l, i) => <div key={i} className="add">+ {l}</div>)}{lines.length > 80 && <div className="muted">… {lines.length - 80} more lines</div>}</pre>
      </div>
    );
  }
  return <pre className="tool-json">{JSON.stringify(input, null, 2)}</pre>;
}

function decidedText(ap: Approval): string {
  const who = { user: 'you', rule: `rule ${ap.rule ?? ''}`.trim(), timeout: 'timeout', lock: 'edit lock', mode: 'Discuss mode', requirements: 'requirements are edited in the PRD tab' }[ap.decidedBy ?? 'user'];
  return `${ap.state === 'allowed' ? 'Allowed' : 'Denied'} by ${who}${ap.reason && ap.state === 'denied' ? ` — ${ap.reason}` : ''}`;
}

// What a card asks, in plain words.
function askTitle(tool: string): string {
  switch (tool) {
    case 'Bash': return 'Run this command?';
    case 'Edit': case 'MultiEdit': return 'Make this edit?';
    case 'Write': return 'Write this file?';
    case 'NotebookEdit': return 'Edit this notebook?';
    case 'WebFetch': return 'Fetch this page?';
    case 'WebSearch': return 'Search the web?';
    default: return `Use ${tool}?`;
  }
}

// What saving a pattern would cover, in words, and which parts of a compound command it would not.
function ruleScope(pattern: string, a: Approval): { covers: string; notCovered: string[] } {
  const m = /^Bash\((.*):\*\)$/.exec(pattern.trim());
  if (m && a.toolName === 'Bash') {
    const prefix = m[1]!;
    const parts = splitCommand(String(a.toolInput.command ?? ''));
    return {
      covers: `commands starting with “${prefix}”`,
      notCovered: parts.filter(p => p !== prefix && !p.startsWith(prefix + ' ')),
    };
  }
  if (/^[A-Za-z]+$/.test(pattern.trim())) return { covers: `every ${pattern.trim()} call`, notCovered: [] };
  return { covers: `calls matching ${pattern.trim()}`, notCovered: [] };
}

function ApprovalCard({ a, rel, inline, mode }: { a: Approval; rel: (p: unknown) => string; inline?: boolean; mode?: string }) {
  const [reason, setReason] = useState('');
  const [pattern, setPattern] = useState(a.suggestedPattern ?? a.toolName);
  const [editingRule, setEditingRule] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (a.state !== 'pending') {
    return inline ? null : <div className={`decided ${a.state}`}>{summary(a.toolName, a.toolInput, rel)} — {decidedText(a)}</div>;
  }
  const go = async (decision: 'allow' | 'deny', save = false) => {
    setBusy(true);
    setError('');
    try {
      await api.decide(a.approvalId, {
        decision,
        reason: decision === 'deny' ? reason : undefined,
        alwaysAllowPattern: decision === 'allow' && save ? pattern.trim() : undefined,
      });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const scope = ruleScope(pattern, a);
  return (
    <div className="card" role="group" aria-label={askTitle(a.toolName)}>
      <div className="card-title">{askTitle(a.toolName)}</div>
      {typeof a.toolInput.description === 'string' && <div className="card-desc">{a.toolInput.description}</div>}
      {/* The whole request, always visible: nothing gets approved unseen. */}
      <ToolInput name={a.toolName} input={a.toolInput} rel={rel} />
      {a.note && <div className="card-note">{a.note}</div>}
      {!editingRule ? (
        <div className="card-actions">
          <button disabled={busy} onClick={() => go('allow')} title="Allow this call only">Allow once</button>
          <button className="ghost" disabled={busy} onClick={() => setEditingRule(true)} title="Save a rule so calls like this run without asking">Always allow…</button>
          <span className="card-spacer" />
          <input placeholder="Reason (optional, Claude sees it)" value={reason} onChange={e => setReason(e.target.value)} />
          <button className="deny" disabled={busy} onClick={() => go('deny')}>Deny</button>
        </div>
      ) : (
        <div className="card-rule">
          <label>
            Rule to save in this project's settings
            <input className="mono" value={pattern} onChange={e => setPattern(e.target.value)} autoFocus />
          </label>
          <div className="muted">
            From now on, {scope.covers} run without asking in this project{mode === 'discuss' ? ' (in Discuss mode, only when they can’t change files)' : ''}.
            You can remove it in Project settings.
          </div>
          {scope.notCovered.length > 0 && (
            <div className="card-note">
              This rule doesn’t cover the rest of this command; those parts will still ask next time:
              {scope.notCovered.map(p => <code key={p}>{p}</code>)}
            </div>
          )}
          <div className="card-actions">
            <button disabled={busy || !pattern.trim()} onClick={() => go('allow', true)}>Save rule and allow</button>
            <button className="ghost" disabled={busy} onClick={() => setEditingRule(false)}>Back</button>
          </div>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

// Links in replies open in a new tab, so following one never navigates away from the chat.
const MD_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
};

// The model for the chat's current mode. "Project default" clears the chat's override.
function ModelPicker({ chat, project, disabled, onChange }: {
  chat: Chat; project: Project; disabled: boolean;
  onChange: (field: 'discussModel' | 'buildModel', value: string | null) => void;
}) {
  const field = chat.mode === 'build' ? 'buildModel' : 'discussModel';
  const overridden = chat.mode === 'build' ? chat.buildModelOverridden : chat.discussModelOverridden;
  const projectDefault = project[field];
  const label = (id: string) => MODELS.find(m => m.id === id)?.label ?? id;
  return (
    <select
      value={overridden ? chat[field] : ''}
      disabled={disabled}
      title={`Model for ${chat.mode === 'build' ? 'Build' : 'Discuss'} turns in this chat`}
      onChange={e => onChange(field, e.target.value || null)}
    >
      <option value="">{label(projectDefault)} (project default)</option>
      {MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
    </select>
  );
}

// What's running in the project's folder — servers the agent left running (a `nohup … &` outlives its
// turn), or ones you started — with their ports and a Stop. Hidden when nothing is running.
function RunningStrip({ project, turnRunning }: { project: Project; turnRunning: boolean }) {
  const [groups, setGroups] = useState<ProcessGroup[]>([]);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [error, setError] = useState('');
  const load = useRef(async () => {});
  load.current = async () => {
    try { setGroups(await api.processes(project.id)); } catch { /* keep the last list; the next poll retries */ }
  };
  useEffect(() => {
    setGroups([]);
    load.current();
    const t = setInterval(() => document.visibilityState === 'visible' && load.current(), 5000);
    return () => clearInterval(t);
  }, [project.id]);
  useEffect(() => { load.current(); }, [turnRunning]); // a turn may have just started or stopped something
  useEffect(() => {
    if (confirming === null) return;
    const t = setTimeout(() => setConfirming(null), 4000);
    return () => clearTimeout(t);
  }, [confirming]);

  if (!groups.length) return null;
  return (
    <div className="running-strip">
      <span className="running-label">Running</span>
      {groups.map(g => (
        <span key={g.pid} className="running-item" title={`pid ${g.pid} · ${g.pids.length} process${g.pids.length === 1 ? '' : 'es'}`}>
          <code>{g.command}</code>
          {g.ports.map(port => (
            <a key={port} href={`http://localhost:${port}`} target="_blank" rel="noopener noreferrer">:{port}</a>
          ))}
          <span className="muted">{uptime(g.secs)}</span>
          <button
            className={`small ${confirming === g.pid ? 'danger' : 'ghost'}`}
            onClick={async () => {
              if (confirming !== g.pid) return setConfirming(g.pid);
              setConfirming(null);
              setError('');
              try { await api.stopProcess(project.id, g.pid); } catch (e) { setError((e as Error).message); }
              setTimeout(() => load.current(), 1000);
            }}
          >
            {confirming === g.pid ? 'Stop it?' : 'Stop'}
          </button>
        </span>
      ))}
      {error && <span className="error">{error}</span>}
    </div>
  );
}

const uptime = (secs: number) =>
  secs < 60 ? `${secs}s` : secs < 3600 ? `${Math.floor(secs / 60)}m` : secs < 86400 ? `${Math.floor(secs / 3600)}h` : `${Math.floor(secs / 86400)}d`;

// How full the chat's context is, and the tokens its turns have used so far.
function UsageBadge({ u }: { u: Usage }) {
  const t = u.total;
  // Used: what was new to the model plus what it wrote. Cache reads (the same conversation re-read on
  // every call) would dwarf it, so they are only in the tooltip.
  const used = t.input + t.cacheWrite + t.output;
  const full = u.window ? u.context / u.window : 0;
  const n = (x: number) => x.toLocaleString();
  const title = [
    `Context: ${n(u.context)}${u.window ? ` of ${n(u.window)} tokens (${Math.round(full * 100)}%)` : ' tokens'} — what the next message starts from.`,
    `Used by this chat so far (${u.turns} turn${u.turns === 1 ? '' : 's'}): ${n(used)} — ${n(t.input + t.cacheWrite)} new input and ${n(t.output)} output.`,
    `Not counted: ${n(t.cacheRead)} read from cache (the conversation re-read on every call).`,
  ].join('\n');
  return (
    <span className={`badge ${full >= 0.8 ? 'warn' : ''}`} title={title}>
      context {tokens(u.context)}{u.window ? ` / ${tokens(u.window)}` : ''}{u.turns ? ` · ${tokens(used)} used` : ''}
    </span>
  );
}
const tokens = (x: number) =>
  x >= 1e6 ? `${+(x / 1e6).toFixed(x < 1e7 ? 1 : 0)}M` : x >= 1e3 ? `${Math.round(x / 1e3)}k` : String(x);

