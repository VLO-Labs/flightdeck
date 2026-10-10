// One chat: the live feed (replayed, then streamed), approval cards, the composer, and the map
// pane — attach nodes as context, watch the agent's reads and edits light the map up.
import { useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FeedItem, MAP_VIEWS, MODELS, type Chat, type MapViewId, type Project } from '../shared/contracts.ts';
import { api } from './api.ts';
import { Crumbs, MapCanvas, nodesForFile, type Heat } from './MapCanvas.tsx';
import { useMap, type NodeRef } from './MapView.tsx';

type Approval = Extract<FeedItem, { kind: 'approval' }>;
type Activity = {
  kind: 'activity'; key: string; runId: number; toolUseId: string; name: string; input: Record<string, unknown>;
  result?: { text: string; isError: boolean }; approval?: Approval;
};
type Block =
  | { kind: 'user'; key: string; text: string; tag?: string; context?: string[] }
  | { kind: 'text'; key: string; text: string }
  | Activity
  | { kind: 'note'; key: string; text: string; tone: 'muted' | 'bad' | 'good' }
  | { kind: 'approval'; key: string; approval: Approval };

type RateLimit = { status?: string; resetsAt?: number; rateLimitType?: string };
// touched: repo-relative paths the latest run read or edited — what lights up the map.
type Derived = {
  blocks: Block[]; partial: string; running: boolean; rateLimit?: RateLimit; model?: string;
  touched: Map<string, Heat>;
};

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);

const str = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => (c && typeof c === 'object' && 'text' in c ? String(c.text) : '')).join('\n');
  return str(content);
}

// Fold the feed into what the screen shows. Pure: same items → same picture, live or replayed.
function derive(items: FeedItem[], roots: string[]): Derived {
  const blocks: Block[] = [];
  const activities = new Map<string, Activity>();
  const approvals = new Map<number, Approval>();
  const approvalBlocks = new Map<number, { kind: 'approval'; key: string; approval: Approval }>();
  let partial = '';
  let running = false;
  let rateLimit: RateLimit | undefined;
  let model: string | undefined;
  let lastRun = -1;

  items.forEach((it, i) => {
    const key = `${i}`;
    if (it.kind === 'user') {
      const label = MODELS.find(m => m.id === it.model)?.label ?? it.model;
      const tag = it.mode ? `${it.mode === 'build' ? 'Build' : 'Discuss'}${label ? ` · ${label}` : ''}` : undefined;
      blocks.push({ kind: 'user', key, text: it.text, tag, context: it.context?.map(c => c.label) });
    } else if (it.kind === 'run') {
      running = it.status === 'started';
      if (it.status === 'started') lastRun = it.runId;
      partial = '';
      if (it.status === 'failed') blocks.push({ kind: 'note', key, tone: 'bad', text: `Run failed${it.detail ? `: ${it.detail}` : ''}` });
      if (it.status === 'stopped') blocks.push({ kind: 'note', key, tone: 'muted', text: `Stopped${it.detail ? ` (${it.detail})` : ''}` });
    } else if (it.kind === 'approval') {
      approvals.set(it.approvalId, it);
      const act = it.toolUseId ? activities.get(it.toolUseId) : undefined;
      if (act) act.approval = it;
      else {
        const existing = approvalBlocks.get(it.approvalId);
        if (existing) existing.approval = it;
        else {
          const b = { kind: 'approval' as const, key, approval: it };
          approvalBlocks.set(it.approvalId, b);
          blocks.push(b);
        }
      }
    } else {
      const ev = it.event as Record<string, any>;
      if (ev.type === 'system' && ev.subtype === 'init') {
        model = ev.model;
      } else if (ev.type === 'stream_event') {
        const d = ev.event?.delta;
        if (ev.event?.type === 'content_block_delta' && d?.type === 'text_delta') partial += d.text;
        if (ev.event?.type === 'message_start') partial = '';
      } else if (ev.type === 'assistant') {
        for (const c of ev.message?.content ?? []) {
          if (c.type === 'text' && c.text?.trim()) {
            blocks.push({ kind: 'text', key: `${key}-${c.id ?? blocks.length}`, text: c.text });
            partial = '';
          } else if (c.type === 'tool_use') {
            const a: Activity = { kind: 'activity', key: `${key}-${c.id}`, runId: it.runId, toolUseId: c.id, name: c.name, input: c.input ?? {} };
            // An approval can arrive before its tool_use in rare orderings; attach it either way.
            for (const ap of approvals.values()) if (ap.toolUseId === c.id) a.approval = ap;
            activities.set(c.id, a);
            blocks.push(a);
          }
        }
      } else if (ev.type === 'user') {
        for (const c of ev.message?.content ?? []) {
          if (c.type === 'tool_result') {
            const a = activities.get(c.tool_use_id);
            if (a) a.result = { text: toolResultText(c.content), isError: !!c.is_error };
          }
        }
      } else if (ev.type === 'system' && ev.subtype === 'permission_denied') {
        // Shown from the stream on purpose: the agent's own summary can misreport a refusal.
        blocks.push({ kind: 'note', key, tone: 'bad', text: `Refused by Claude Code: ${ev.message ?? ev.tool_name}` });
      } else if (ev.type === 'system' && ev.subtype === 'task_started' && ev.is_backgrounded) {
        blocks.push({ kind: 'note', key, tone: 'muted', text: `Background task started: ${ev.description}` });
      } else if (ev.type === 'rate_limit_event') {
        rateLimit = ev.rate_limit_info;
      } else if (ev.type === 'result') {
        const secs = typeof ev.duration_ms === 'number' ? ` · ${(ev.duration_ms / 1000).toFixed(0)}s` : '';
        // Judge by is_error, never by subtype.
        if (ev.is_error) blocks.push({ kind: 'note', key, tone: 'bad', text: `Turn ended with an error (${ev.subtype})${secs}` });
        else blocks.push({ kind: 'note', key, tone: 'muted', text: `Done${secs}` });
      }
    }
  });
  // What the latest run touched. An edit counts once it succeeded (or while it is still in
  // flight); a refused or failed edit lights nothing.
  const touched = new Map<string, Heat>();
  const toRel = (p: unknown) => {
    if (typeof p !== 'string') return undefined;
    for (const r of roots) if (p === r) return ''; else if (p.startsWith(r + '/')) return p.slice(r.length + 1);
    return undefined;
  };
  for (const b of blocks) {
    if (b.kind !== 'activity' || b.runId !== lastRun) continue;
    const rel = toRel(b.input.file_path ?? b.input.notebook_path ?? b.input.path);
    if (rel === undefined) continue;
    if (EDIT_TOOLS.has(b.name)) {
      const ok = b.approval?.state !== 'denied' && !(b.result?.isError);
      if (ok) touched.set(rel, 'edit');
    } else if (READ_TOOLS.has(b.name) && touched.get(rel) !== 'edit') {
      touched.set(rel, 'read');
    }
  }
  return { blocks, partial, running, rateLimit, model, touched };
}

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
  const stick = useRef(true);

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

  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [d]);

  const send = async () => {
    const text = draft.trim();
    if (!text || d.running) return;
    setError('');
    try {
      await api.send(chat.id, text, ctx.map(c => ({ view: c.view, nodeId: c.nodeId })));
      setDraft('');
      setCtx([]);
      stick.current = true;
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
    <div className="chat">
      <header className="chat-header">
        <div className="chat-name">{chat.title}</div>
        <div className="chat-meta">
          <div className="mode-toggle" title="Discuss: read, analyze, plan — edits are refused. Build: may change code.">
            {(['discuss', 'build'] as const).map(m => (
              <button
                key={m}
                className={cur.mode === m ? 'on' : ''}
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

      <div
        className="feed"
        onScroll={e => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {d.blocks.map(b => {
          switch (b.kind) {
            case 'user':
              return (
                <div key={b.key} className="msg user">
                  {b.context && <div className="chips">{b.context.map(l => <span key={l} className="chip">{l}</span>)}</div>}
                  {b.text}
                  {b.tag && <div className="msg-tag">{b.tag}</div>}
                </div>
              );
            case 'text':
              return <div key={b.key} className="msg assistant"><Markdown remarkPlugins={[remarkGfm]}>{b.text}</Markdown></div>;
            case 'note':
              return <div key={b.key} className={`note ${b.tone}`}>{b.text}</div>;
            case 'approval':
              return <ApprovalCard key={b.key} a={b.approval} rel={rel} />;
            case 'activity':
              return <ActivityLine key={b.key} a={b} rel={rel} />;
          }
        })}
        {d.partial && <div className="msg assistant partial"><Markdown remarkPlugins={[remarkGfm]}>{d.partial}</Markdown></div>}
        {d.running && !d.partial && <div className="note muted working">Working…</div>}
        <div ref={bottom} />
      </div>

      <footer className="composer">
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
    </div>
  );
}

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

function ActivityLine({ a, rel }: { a: Activity; rel: (p: unknown) => string }) {
  const [open, setOpen] = useState(false);
  const ap = a.approval;
  const denied = ap?.state === 'denied';
  const state = denied ? 'bad' : a.result?.isError ? 'bad' : a.result ? 'good' : 'pending';
  return (
    <div className={`activity ${state}`}>
      <button className="activity-line" onClick={() => setOpen(o => !o)}>
        <span className="dot" />
        <span className="activity-text">{summary(a.name, a.input, rel)}</span>
        {typeof a.input.description === 'string' && a.name === 'Bash' && <span className="activity-desc">{a.input.description}</span>}
      </button>
      {ap && ap.state === 'pending' && <ApprovalCard a={ap} rel={rel} inline />}
      {ap && ap.state !== 'pending' && ap.decidedBy !== 'rule' && (
        <div className={`decided ${ap.state}`}>{decidedText(ap)}</div>
      )}
      {ap && ap.state === 'denied' && ap.decidedBy === 'rule' && <div className="decided denied">{decidedText(ap)}</div>}
      {open && (
        <div className="activity-detail">
          <pre>{JSON.stringify(a.input, null, 2)}</pre>
          {a.result && <pre className={a.result.isError ? 'bad' : ''}>{a.result.text.slice(0, 5000)}</pre>}
        </div>
      )}
    </div>
  );
}

function decidedText(ap: Approval): string {
  const who = { user: 'you', rule: `rule ${ap.rule ?? ''}`.trim(), timeout: 'timeout', lock: 'edit lock', mode: 'Discuss mode' }[ap.decidedBy ?? 'user'];
  return `${ap.state === 'allowed' ? 'Allowed' : 'Denied'} by ${who}${ap.reason && ap.state === 'denied' ? ` — ${ap.reason}` : ''}`;
}

function ApprovalCard({ a, rel, inline }: { a: Approval; rel: (p: unknown) => string; inline?: boolean }) {
  const [reason, setReason] = useState('');
  const [pattern, setPattern] = useState(a.suggestedPattern ?? a.toolName);
  const [always, setAlways] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (a.state !== 'pending') {
    return inline ? null : <div className={`decided ${a.state}`}>{summary(a.toolName, a.toolInput, rel)} — {decidedText(a)}</div>;
  }
  const go = async (decision: 'allow' | 'deny') => {
    setBusy(true);
    setError('');
    try {
      await api.decide(a.approvalId, {
        decision,
        reason: decision === 'deny' ? reason : undefined,
        alwaysAllowPattern: decision === 'allow' && always ? pattern.trim() : undefined,
      });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <div className="card-title">Claude wants to run</div>
      {!inline && <div className="card-tool">{summary(a.toolName, a.toolInput, rel)}</div>}
      {typeof a.toolInput.description === 'string' && <div className="card-desc">{a.toolInput.description}</div>}
      <details>
        <summary>Full request</summary>
        <pre>{JSON.stringify(a.toolInput, null, 2)}</pre>
      </details>
      <label className="always">
        <input type="checkbox" checked={always} onChange={e => setAlways(e.target.checked)} />
        Always allow in this project:
        <input value={pattern} onChange={e => setPattern(e.target.value)} disabled={!always} />
      </label>
      <div className="card-actions">
        <button disabled={busy} onClick={() => go('allow')}>Allow</button>
        <input placeholder="Reason (optional, Claude sees it)" value={reason} onChange={e => setReason(e.target.value)} />
        <button className="deny" disabled={busy} onClick={() => go('deny')}>Deny</button>
      </div>
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
