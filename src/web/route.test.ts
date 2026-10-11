import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRoute, parseRoute, type Route } from './route.ts';

const roundTrip = (r: Route) => {
  const url = new URL(formatRoute(r), 'http://x');
  return parseRoute(url.pathname, url.search);
};

test('every screen survives a round trip through the URL', () => {
  const routes: Route[] = [
    { projectId: 6, screen: 'none' },
    { projectId: 6, screen: 'settings' },
    { projectId: 6, screen: 'chat', chatId: 12 },
    { projectId: 6, screen: 'map', mapView: 'flows', at: ['chat-turn', 'ct-spawn'], node: 'ct-parse' },
    { projectId: 2, screen: 'map', mapView: 'architecture', at: [], node: null },
  ];
  for (const r of routes) assert.deepEqual(roundTrip(r), r);
  assert.equal(formatRoute(routes[3]!), '/p/6/map/flows?at=chat-turn/ct-spawn&node=ct-parse');
});

test('unknown or malformed URLs fall back instead of failing', () => {
  assert.deepEqual(parseRoute('/', ''), { screen: 'none' });
  assert.deepEqual(parseRoute('/p/abc/map', ''), { screen: 'none' });
  assert.deepEqual(parseRoute('/p/6/map/nonsense', ''), { projectId: 6, screen: 'map', mapView: 'architecture', at: [], node: null });
  assert.deepEqual(parseRoute('/p/6/chats/x', ''), { projectId: 6, screen: 'none' });
});
