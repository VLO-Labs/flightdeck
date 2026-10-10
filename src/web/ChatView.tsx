// One chat: the live feed (replayed, then streamed), approval cards, and the composer.
import { useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FeedItem, MODELS, type Chat, type Project } from '../shared/contracts.ts';
import { api } from './api.ts';

type Approval = Extract<FeedItem, { kind: 'approval' }>;
type Activity = {
  kind: 'activity'; key: string; toolUseId: string; name: string; input: Record<string, unknown>;
  result?: { text: string; isError: boolean }; approval?: Approval;
};
type Block =
  | { kind: 'user'; key: string; text: string; tag?: string }
  | { kind: 'text'; key: string; text: string }
  | Activity
  | { kind: 'note'; key: string; text: string; tone: 'muted' | 'bad' | 'good' }
  | { kind: 'approval'; key: string; approval: Approval };

type RateLimit = { status?: string; resetsAt?: number; rateLimitType?: string };
type Derived = { blocks: Block[]; partial: string; running: boolean; rateLimit?: RateLimit; model?: string };

const str = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => (c && typeof c === 'object' && 'text' in c ? String(c.text) : '')).join('\n');
  return str(content);
}

// Fold the feed into what the screen shows. Pure: same items → same picture, live or replayed.
function derive(items: FeedItem[]): Derived {
  const blocks: Block[] = [];
  const activities = new Map<string, Activity>();
  const approvals = new Map<number, Approval>();
  const approvalBlocks = new Map<number, { kind: 'approval'; key: string; approval: Approval }>();
  let partial = '';
  let running = false;
  let rateLimit: RateLimit | undefined;
  let model: string | undefined;

  items.forEach((it, i) => {
    const key = `${i}`;
    if (it.kind === 'user') {
      const label = MODELS.find(m => m.id === it.model)?.label ?? it.model;
      const tag = it.mode ? `${it.mode === 'build' ? 'Build' : 'Discuss'}${label ? ` · ${label}` : ''}` : undefined;
      blocks.push({ kind: 'user', key, text: it.text, tag });
    } else if (it.kind === 'run') {
      running = it.status === 'started';
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
            const a: Activity = { kind: 'activity', key: `${key}-${c.id}`, toolUseId: c.id, name: c.name, input: c.input ?? {} };
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
  return { blocks, partial, running, rateLimit, model };
}

export function ChatView({ chat, project, onChanged }: { chat: Chat; project: Project; onChanged: () => void }) {
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

  const d = useMemo(() => derive(items), [items]);

  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [d]);

  const send = async () => {
    const text = draft.trim();
    if (!text || d.running) return;
    setError('');
    try {
      await api.send(chat.id, text);
      setDraft('');
      stick.current = true;
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const rel = (p: unknown) => (typeof p === 'string' && p.startsWith(project.path + '/') ? p.slice(project.path.length + 1) : str(p));

  return (
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
  );
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
