// One chat: the live feed (replayed, then streamed), approval cards, the composer, and the map
// pane — attach nodes as context, watch the agent's reads and edits light the map up.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FeedItem, MAP_VIEWS, MODELS, type Chat, type MapViewId, type Project } from '../shared/contracts.ts';
import { splitCommand } from '../shared/shell.ts';
import { actState, derive, groupActivities, groupSummary, str, type Activity, type ActState, type Approval, type RateLimit } from './feedModel.ts';
import { api } from './api.ts';
import { Crumbs, MapCanvas, nodesForFile, type Heat } from './MapCanvas.tsx';
import { useMap, type NodeRef } from './MapView.tsx';
import { FileViewer } from './FileViewer.tsx';

export function ChatView({ chat, project, onChanged, initialContext }: {
  chat: Chat; project: Project; onChanged: () => void; initialContext?: NodeRef[];
}) {
  const [ctx, setCtx] = useState<NodeRef[]>(initialContext ?? []);
  const [showMap, setShowMap] = useState(() => storageGet('fd.chatmap') !== '0');
  const [items, setItems] = useState<FeedItem[]>([]);
  const [connected, setConnected] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [cur, setCur] = useState(chat); // optimistic copy of the chat's mode/models
  useEffect(() => setCur(chat), [chat]);
  const bottom = useRef<HTMLDivElement>(null);
  const feed = useRef<HTMLDivElement>(null);
  // Following the bottom, unless the reader scrolled up; then new output only raises a button.
  const stick = useRef(scrollMemory.get(chat.id) == null);
  const restored = useRef(false);
  const [behind, setBehind] = useState(false);

  useEffect(() => {
    setItems([]);
    const es = new EventSource(`/api/chats/${chat.id}/feed`);
    let buffer: FeedItem[] = [];
    let replaying = true;
    es.onopen = () => setConnected(true);
    es.onerror = () => {
      setConnected(false);
      // EventSource reconnects by itself; the server replays everything, so start clean.
      buffer = [];
      replaying = true;
      setItems([]);
    };
    es.addEventListener('replayed', () => {
      replaying = false;
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
  const rows = useMemo(() => groupActivities(d.blocks, d.ended), [d]);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  // A file Claude read or edited, opened in the code viewer (at a line when one is known).
  const [viewing, setViewing] = useState<{ path: string; line?: number } | null>(null);
  const openFile = (path: string, line?: number) => setViewing({ path, line });

  // Coming back to a chat puts it where it was left; the first time, at the end.
  useLayoutEffect(() => {
    if (restored.current || items.length === 0 || !feed.current) return;
    restored.current = true;
    const saved = scrollMemory.get(chat.id);
    if (saved != null) feed.current.scrollTop = saved;
    else bottom.current?.scrollIntoView({ block: 'end' });
  }, [items, chat.id]);

  useEffect(() => {
    if (!restored.current) return;
    if (stick.current) bottom.current?.scrollIntoView({ block: 'end' });
    else setBehind(true);
  }, [d]);
  const toBottom = () => {
    stick.current = true;
    setBehind(false);
    scrollMemory.delete(chat.id);
    bottom.current?.scrollIntoView({ block: 'end' });
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || d.running) return;
    setError('');
    try {
      await api.send(chat.id, text, ctx.map(c => ({ view: c.view, nodeId: c.nodeId })));
      setDraft('');
      setCtx([]);
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
  const toggleCtx = (n: NodeRef) =>
    setCtx(cs => (cs.some(c => c.view === n.view && c.nodeId === n.nodeId) ? cs.filter(c => !(c.view === n.view && c.nodeId === n.nodeId)) : [...cs, n]));

  return (
    <div className="chat-split">
    <div className={`chat mode-${cur.mode}`}>
      <header className="chat-header">
        <div className="chat-name">{chat.title}</div>
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
          {d.rateLimit && <RateLimitBadge r={d.rateLimit} />}
          {!connected && <span className="badge bad">reconnecting…</span>}
          <button
            className={`small ${showMap ? '' : 'ghost'}`}
            onClick={() => setShowMap(v => { storageSet('fd.chatmap', v ? '0' : '1'); return !v; })}
          >
            {showMap ? 'Hide map' : 'Map'}
          </button>
        </div>
      </header>

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
              return <div key={b.key} className="msg assistant md"><Markdown remarkPlugins={[remarkGfm]}>{b.text}</Markdown></div>;
            case 'note':
              return <div key={b.key} className={`note ${b.tone}`}>{b.text}</div>;
            case 'approval':
              return <ApprovalCard key={b.key} a={b.approval} rel={rel} mode={cur.mode} />;
            case 'activity':
              return <ActivityLine key={b.key} a={b} state={actState(b, d.ended)} rel={rel} onOpenFile={openFile} mode={cur.mode} />;
          }
        })}
        {d.partial && <div className="msg assistant partial"><Markdown remarkPlugins={[remarkGfm]}>{d.partial}</Markdown></div>}
        {d.running && !d.partial && <div className="note muted working">Working…</div>}
        <div ref={bottom} />
      </div>
      {behind && <button className="small new-below" onClick={toBottom}>New activity ↓</button>}
      </div>

      <footer className="composer">
        <div className="mode-line">
          {cur.mode === 'build'
            ? <><strong>Build</strong> — Claude may change files in this project (as your rules allow).</>
            : <><strong>Discuss</strong> — read-only: Claude reads and proposes; edits are refused.</>}
        </div>
        {error && <div className="error">{error}</div>}
        {ctx.length > 0 && (
          <div className="chips composer-chips">
            {ctx.map(c => (
              <span key={`${c.view}:${c.nodeId}`} className="chip">
                {c.label}
                <button className="chip-x" title="Remove" onClick={() => toggleCtx(c)}>×</button>
              </span>
            ))}
          </div>
        )}
        <textarea
          value={draft}
          placeholder={d.running ? 'Claude is working — stop it or wait for it to finish' : 'Message Claude Code (Enter to send, Shift+Enter for a new line)'}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={3}
        />
        {d.running
          ? <button className="stop" onClick={() => api.stop(chat.id)}>Stop</button>
          : <button onClick={send} disabled={!draft.trim()}>Send</button>}
      </footer>
    </div>
    {showMap && <ChatMapPane project={project} ctx={ctx} onToggle={toggleCtx} touched={d.touched} live={d.running} />}
    {viewing && (
      <FileViewer
        project={project} path={viewing.path} line={viewing.line}
        onOpen={p => setViewing({ path: p })} onClose={() => setViewing(null)}
      />
    )}
    </div>
  );
}

// Where each chat was left, per chat id; absent = following the end. Lives for the page's lifetime.
const scrollMemory = new Map<number, number>();

const toggled = (s: Set<string>, k: string) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; };

// The map beside the chat: click a node to attach it to the next message; nodes light up as the
// latest run reads (blue) or edits (amber) the files behind them.
function ChatMapPane({ project, ctx, onToggle, touched, live }: {
  project: Project; ctx: NodeRef[]; onToggle: (n: NodeRef) => void; touched: Map<string, Heat>; live: boolean;
}) {
  const [view, setView] = useState<MapViewId>('architecture');
  const { data } = useMap(project.id, view);
  const [path, setPath] = useState<string[]>([]);
  useEffect(() => setPath([]), [view]);

  const map = data?.map ?? null;
  const stale = useMemo(() => new Set(data?.staleNodeIds ?? []), [data]);
  const inContext = useMemo(() => new Set(ctx.filter(c => c.view === view).map(c => c.nodeId)), [ctx, view]);
  const heat = useMemo(() => {
    const out = new Map<string, Heat>();
    if (!map) return out;
    for (const [rel, h] of touched) {
      for (const id of nodesForFile(map, rel)) if (out.get(id) !== 'edit') out.set(id, h);
    }
    return out;
  }, [map, touched]);

  return (
    <aside className="chat-map">
      <div className="chat-map-head">
        <div className="map-tabs">
          {MAP_VIEWS.map(v => <button key={v.id} className={v.id === view ? 'on' : ''} onClick={() => setView(v.id)}>{v.label}</button>)}
        </div>
        <span className="muted chat-map-legend">
          {touched.size > 0 ? (live ? 'This run: ' : 'Last run: ') : ''}
          <span className="heat-tag read">read</span> <span className="heat-tag edit">edited</span>
        </span>
      </div>
      {map && <Crumbs map={map} root={project.name} path={path} onPath={setPath} />}
      <div className="chat-map-canvas">
        {map
          ? <MapCanvas
              map={map} view={view} stale={stale} path={path} onPath={setPath} inContext={inContext} heat={heat}
              // A narrow side pane, used to pick nodes: an overview matters more than full-size text.
              minFitZoom={0.35}
              onSelect={id => {
                const n = id ? map.nodes.find(x => x.id === id) : undefined;
                if (n) onToggle({ view, nodeId: n.id, label: n.label });
              }}
            />
          : <div className="empty muted">No {view} map yet — make one from the project's Map screen.</div>}
      </div>
      <div className="chat-map-foot muted">Click a node to attach it to your message · double-click to open it</div>
    </aside>
  );
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
  const who = { user: 'you', rule: `rule ${ap.rule ?? ''}`.trim(), timeout: 'timeout', lock: 'edit lock', mode: 'Discuss mode' }[ap.decidedBy ?? 'user'];
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

function RateLimitBadge({ r }: { r: RateLimit }) {
  const reset = r.resetsAt ? new Date(r.resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const ok = r.status === 'allowed';
  return (
    <span className={`badge ${ok ? '' : 'bad'}`} title={`Subscription ${r.rateLimitType ?? ''} window`}>
      {ok ? 'plan OK' : `plan ${r.status}`}{reset ? ` · resets ${reset}` : ''}
    </span>
  );
}
