// The chat screen's layout state, kept apart from React so it can be tested: the workspace tabs,
// where the divider sits, and what each chat had open when you left it.
import { MAP_VIEWS, type MapViewId } from '../shared/contracts.ts';
import type { NodeRef } from './MapView.tsx';

export type WorkspaceTab = 'prd' | MapViewId | 'code';

export const WORKSPACE_TABS: { id: WorkspaceTab; label: string }[] = [
  { id: 'prd', label: 'PRD' },
  ...MAP_VIEWS,
  { id: 'code', label: 'Code' },
];

export const isWorkspaceTab = (v: unknown): v is WorkspaceTab => WORKSPACE_TABS.some(t => t.id === v);
export const isMapTab = (t: WorkspaceTab): t is MapViewId => MAP_VIEWS.some(m => m.id === t);

// The divider: the chat's share of the split, in percent. Each side keeps a usable minimum; when
// the screen is too narrow for both minimums the split is shown one panel at a time instead (CSS).
export const SPLIT_DEFAULT = 35;
export const CHAT_MIN_PX = 340;
export const WORKSPACE_MIN_PX = 360;

export function clampSplit(pct: number, totalPx: number): number {
  if (!Number.isFinite(pct)) return SPLIT_DEFAULT;
  if (totalPx < CHAT_MIN_PX + WORKSPACE_MIN_PX) return Math.min(Math.max(pct, 0), 100);
  const lo = (CHAT_MIN_PX / totalPx) * 100;
  const hi = 100 - (WORKSPACE_MIN_PX / totalPx) * 100;
  return Math.round(Math.min(Math.max(pct, lo), hi) * 10) / 10;
}

// What can be attached to a message: a map node, or a requirement / section of a requirements document.
export type ReqRef = { doc: string; ref: string; label: string };
export type ContextRef = NodeRef | ReqRef;
export const isNodeRef = (c: ContextRef): c is NodeRef => 'view' in c;
export const ctxKey = (c: ContextRef) => (isNodeRef(c) ? `map:${c.view}:${c.nodeId}` : `req:${c.doc}:${c.ref}`);
export const toggleIn = (cs: ContextRef[], c: ContextRef) =>
  (cs.some(x => ctxKey(x) === ctxKey(c)) ? cs.filter(x => ctxKey(x) !== ctxKey(c)) : [...cs, c]);

// What a chat had in hand when you switched away: the unsent message, the context attached to it,
// the workspace tab and file. Per chat id (ids are global, so projects never share an entry), for
// the page's lifetime; the draft is also kept in localStorage so a reload doesn't lose it.
export type ChatMemory = { draft: string; ctx: ContextRef[]; tab?: WorkspaceTab; file?: { path: string; line?: number } };

const memory = new Map<number, ChatMemory>();
const draftKey = (chatId: number) => `fd.draft.${chatId}`;

export function recall(chatId: number, storage?: Pick<Storage, 'getItem'>): ChatMemory {
  const m = memory.get(chatId);
  if (m) return m;
  let draft = '';
  try { draft = storage?.getItem(draftKey(chatId)) ?? ''; } catch { /* storage blocked */ }
  return { draft, ctx: [] };
}

export function remember(chatId: number, m: ChatMemory, storage?: Pick<Storage, 'setItem' | 'removeItem'>) {
  memory.set(chatId, m);
  try {
    if (m.draft) storage?.setItem(draftKey(chatId), m.draft);
    else storage?.removeItem(draftKey(chatId));
  } catch { /* not essential */ }
}

export function forgetAll() { memory.clear(); } // tests
