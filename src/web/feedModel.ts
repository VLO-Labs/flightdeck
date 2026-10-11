// The chat feed as the screen sees it: fold raw feed items into blocks, and settle each tool call's
// state. Pure (no React), so it can be tested directly.
import { MODELS, type FeedItem } from '../shared/contracts.ts';
import type { Heat } from './graph.ts';

export type Approval = Extract<FeedItem, { kind: 'approval' }>;
export type Activity = {
  kind: 'activity'; key: string; runId: number; toolUseId: string; name: string; input: Record<string, unknown>;
  result?: { text: string; isError: boolean }; approval?: Approval;
};
export type Block =
  | { kind: 'user'; key: string; text: string; tag?: string; context?: string[] }
  | { kind: 'text'; key: string; text: string }
  | Activity
  | { kind: 'note'; key: string; text: string; tone: 'muted' | 'bad' | 'good' }
  | { kind: 'approval'; key: string; approval: Approval }
  | { kind: 'req-proposal'; key: string; proposalId: number; path: string; summary: string }
  | { kind: 'plan'; key: string; versionId: number; version: number; title: string; counts: { added: number; changed: number; removed: number } }
  | { kind: 'check'; key: string; checkId: number; version: number; versionId?: number; counts: Record<string, number>; failed?: string };

export type RateLimit = { status?: string; resetsAt?: number; rateLimitType?: string };
// touched: repo-relative paths the latest run read or edited — what lights up the map.
type Derived = {
  blocks: Block[]; partial: string; running: boolean; rateLimit?: RateLimit; model?: string;
  touched: Map<string, Heat>;
  ended: Set<number>; // runs that are over (finished, failed or stopped)
};

// One tool call's state, from its approval, its result and whether its run is still going.
export type ActState = 'running' | 'waiting' | 'done' | 'failed' | 'denied' | 'cancelled';
export function actState(a: Activity, ended: Set<number>): ActState {
  if (a.approval?.state === 'denied') return 'denied';
  if (a.result) return a.result.isError ? 'failed' : 'done';
  if (a.approval?.state === 'pending') return 'waiting';
  return ended.has(a.runId) ? 'cancelled' : 'running';
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);

export const str = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => (c && typeof c === 'object' && 'text' in c ? String(c.text) : '')).join('\n');
  return str(content);
}

// Fold the feed into what the screen shows. Pure: same items → same picture, live or replayed.
export function derive(items: FeedItem[], roots: string[]): Derived {
  const blocks: Block[] = [];
  const activities = new Map<string, Activity>();
  const approvals = new Map<number, Approval>();
  const approvalBlocks = new Map<number, { kind: 'approval'; key: string; approval: Approval }>();
  let partial = '';
  let running = false;
  let rateLimit: RateLimit | undefined;
  let model: string | undefined;
  let lastRun = -1;
  const ended = new Set<number>();

  items.forEach((it, i) => {
    const key = `${i}`;
    if (it.kind === 'user') {
      const label = MODELS.find(m => m.id === it.model)?.label ?? it.model;
      const tag = it.mode ? `${it.mode === 'build' ? 'Build' : 'Discuss'}${label ? ` · ${label}` : ''}` : undefined;
      blocks.push({ kind: 'user', key, text: it.text, tag, context: it.context?.map(c => c.label) });
    } else if (it.kind === 'run') {
      running = it.status === 'started';
      if (it.status === 'started') lastRun = it.runId;
      else ended.add(it.runId);
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
    } else if (it.kind === 'plan-dropped') {
      blocks.push({ kind: 'note', key, tone: 'muted', text: it.by === 'agent' ? 'Plan dropped, as you asked in the chat.' : 'Plan dropped.' });
    } else if (it.kind === 'check') {
      blocks.push({ kind: 'check', key, checkId: it.checkId, version: it.version, versionId: it.versionId, counts: it.counts, failed: it.failed });
    } else if (it.kind === 'req-proposal') {
      blocks.push({ kind: 'req-proposal', key, proposalId: it.proposalId, path: it.path, summary: it.summary });
    } else if (it.kind === 'plan') {
      blocks.push({ kind: 'plan', key, versionId: it.versionId, version: it.version, title: it.title, counts: it.counts });
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
  return { blocks, partial, running, rateLimit, model, touched, ended };
}


export type Row = { kind: 'block'; block: Block } | { kind: 'group'; key: string; items: Activity[] };

// Settled tool calls are folded into one row once Claude has moved on: three or more in a row,
// all finished (done or cancelled), followed by something else. Anything waiting, running, failed
// or denied stays in view on its own.
const GROUP_MIN = 3;
export function groupActivities(blocks: Block[], ended: Set<number>): Row[] {
  const rows: Row[] = [];
  let run: Activity[] = [];
  const flush = (followed: boolean) => {
    if (followed && run.length >= GROUP_MIN) rows.push({ kind: 'group', key: `g${run[0]!.key}`, items: run });
    else for (const a of run) rows.push({ kind: 'block', block: a });
    run = [];
  };
  for (const b of blocks) {
    const quiet = b.kind === 'activity' && ['done', 'cancelled'].includes(actState(b, ended));
    if (quiet) { run.push(b as Activity); continue; }
    flush(true);
    rows.push({ kind: 'block', block: b });
  }
  flush(false);
  return rows;
}

export function groupSummary(items: Activity[], ended: Set<number>): string {
  const counts = new Map<string, number>();
  for (const a of items) counts.set(a.name, (counts.get(a.name) ?? 0) + 1);
  const parts = [...counts].sort((x, y) => y[1] - x[1]).map(([n, c]) => `${n} ${c}`);
  const cancelled = items.filter(a => actState(a, ended) === 'cancelled').length;
  return parts.join(' · ') + (cancelled ? ` · ${cancelled} cancelled` : '');
}
