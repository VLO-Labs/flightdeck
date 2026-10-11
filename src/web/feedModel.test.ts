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
