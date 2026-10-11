import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLIGHTDECK_DATA = join(mkdtempSync(join(tmpdir(), 'fd-mcp-')), 'data');
const { handleMcp } = await import('./mcp.ts');

const call = (headers: Record<string, string>, body: unknown = { jsonrpc: '2.0', id: 1, method: 'tools/list' }) =>
  handleMcp(new Request('http://127.0.0.1:8100/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));

test('no token, or a token no running Discuss turn holds, is refused', async () => {
  assert.equal((await call({})).status, 401);
  assert.equal((await call({ authorization: 'Bearer ' + 'a'.repeat(64) })).status, 401);
});

test('anything a browser page sends is refused, token or not', async () => {
  assert.equal((await call({ origin: 'https://evil.example', authorization: 'Bearer x' })).status, 403);
  assert.equal((await call({ origin: 'http://flightdeck.vlolabs' })).status, 403);
});
