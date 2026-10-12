import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FeedItem } from '../shared/contracts.ts';
import { actState, derive, groupActivities, type Activity } from './feedModel.ts';

const at = '2026-10-11T00:00:00.000Z';
const run = (runId: number, status: 'started' | 'finished' | 'failed' | 'stopped'): FeedItem => ({ kind: 'run', at, runId, status });
const toolUse = (runId: number, id: string, name = 'Read'): FeedItem =>
  ({ kind: 'claude', at, runId, event: { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: { file_path: `/repo/${id}.ts` } }] } } });
const toolResult = (runId: number, id: string, isError = false): FeedItem =>
  ({ kind: 'claude', at, runId, event: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: isError }] } } });
const text = (runId: number, t: string): FeedItem =>
  ({ kind: 'claude', at, runId, event: { type: 'assistant', message: { content: [{ type: 'text', text: t }] } } });

const activities = (items: FeedItem[]) => {
  const d = derive(items, ['/repo']);
  return { d, acts: d.blocks.filter((b): b is Activity => b.kind === 'activity') };
};

test('a tool call without a result is running while its run is live, cancelled once the run is over', () => {
  const live = activities([run(1, 'started'), toolUse(1, 'a')]);
  assert.equal(actState(live.acts[0]!, live.d.ended), 'running');
  const stopped = activities([run(1, 'started'), toolUse(1, 'a'), run(1, 'stopped')]);
  assert.equal(actState(stopped.acts[0]!, stopped.d.ended), 'cancelled');
});

test('results settle a call as done or failed', () => {
  const { d, acts } = activities([run(1, 'started'), toolUse(1, 'a'), toolResult(1, 'a'), toolUse(1, 'b'), toolResult(1, 'b', true)]);
  assert.deepEqual(acts.map(a => actState(a, d.ended)), ['done', 'failed']);
});

test('three or more settled calls fold into a group once Claude moves on; a failure stays visible', () => {
  const items = [
    run(1, 'started'),
    toolUse(1, 'a'), toolResult(1, 'a'), toolUse(1, 'b'), toolResult(1, 'b'), toolUse(1, 'c'), toolResult(1, 'c'),
    toolUse(1, 'x'), toolResult(1, 'x', true),
    text(1, 'done'),
  ];
  const { d } = activities(items);
  const rows = groupActivities(d.blocks, d.ended);
  assert.deepEqual(rows.map(r => (r.kind === 'group' ? `group:${r.items.length}` : r.block.kind)), ['group:3', 'activity', 'text']);
});

test('settled calls at the end of a live run are not folded yet (more may follow)', () => {
  const { d } = activities([run(1, 'started'), toolUse(1, 'a'), toolResult(1, 'a'), toolUse(1, 'b'), toolResult(1, 'b'), toolUse(1, 'c'), toolResult(1, 'c')]);
  assert.ok(groupActivities(d.blocks, d.ended).every(r => r.kind === 'block'));
});

test('token use: context from the latest call of the chat itself, totals from finished turns', () => {
  const ev = (runId: number, event: { type: string; [k: string]: unknown }): FeedItem => ({ kind: 'claude', at, runId, event });
  const call = (input: number, read: number, write: number, output: number, parent?: string) =>
    ({ type: 'assistant', parent_tool_use_id: parent ?? null, message: { content: [], usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: output } } });
  const result = (input: number, read: number, write: number, output: number) =>
    ({ type: 'result', is_error: false, usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: output }, modelUsage: { 'claude-haiku-5-5': { contextWindow: 1_000_000 }, 'claude-opus-5-5': { contextWindow: 200_000 } } });
  assert.equal(derive([run(1, 'started')], ['/repo']).usage, undefined);
  const items = [
    run(1, 'started'), ev(1, { type: 'system', subtype: 'init', model: 'claude-haiku-5-5' }),
    ev(1, call(2, 10_000, 500, 40)),
    ev(1, call(5, 90_000, 9_000, 900, 'toolu_sub')), // a subagent's call: its own context
    ev(1, result(4, 20_000, 1_000, 300)), run(1, 'finished'),
  ];
  const first = derive(items, ['/repo']).usage!;
  assert.deepEqual(first, { context: 10_542, window: 1_000_000, turns: 1, total: { input: 4, cacheRead: 20_000, cacheWrite: 1_000, output: 300 } });
  // Mid-turn: the context moves with each call; the totals wait for the turn to end.
  const mid = derive([...items, run(2, 'started'), ev(2, call(3, 11_000, 200, 7))], ['/repo']).usage!;
  assert.equal(mid.context, 11_210);
  assert.equal(mid.turns, 1);
});
