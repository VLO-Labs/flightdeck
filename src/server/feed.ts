// A chat's feed: an append-only JSONL file (the replay) plus live subscribers (SSE).
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FeedItem } from '../shared/contracts.ts';
import { config } from './config.ts';

type Listener = (item: FeedItem) => void;
const listeners = new Map<number, Set<Listener>>();

const file = (chatId: number) => join(config.dataDir, 'chats', `${chatId}.jsonl`);

export function append(chatId: number, item: FeedItem): void {
  appendFileSync(file(chatId), JSON.stringify(item) + '\n');
  for (const l of listeners.get(chatId) ?? []) l(item);
}

export function replay(chatId: number): FeedItem[] {
  if (!existsSync(file(chatId))) return [];
  const out: FeedItem[] = [];
  for (const line of readFileSync(file(chatId), 'utf8').split('\n')) {
    if (!line) continue;
    const parsed = FeedItem.safeParse(JSON.parse(line));
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export function subscribe(chatId: number, l: Listener): () => void {
  let set = listeners.get(chatId);
  if (!set) listeners.set(chatId, (set = new Set()));
  set.add(l);
  return () => set.delete(l);
}
