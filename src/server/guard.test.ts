import { test } from 'node:test';
import assert from 'node:assert/strict';

// An extra name, as an /etc/hosts entry would give; config reads it when it loads.
process.env.FLIGHTDECK_HOSTNAMES = 'flightdeck.example';
const { refuseLocal } = await import('./guard.ts');

const req = (method: string, headers: Record<string, string>) =>
  new Request('http://localhost:8100/api/chats/1/messages', { method, headers });

test('Flightdeck\'s own page and the claude hook get through', () => {
  assert.equal(refuseLocal(req('GET', { host: 'localhost:8100' })), null);
  assert.equal(refuseLocal(req('POST', { host: 'localhost:8100', origin: 'http://localhost:8100', 'content-type': 'application/json' })), null);
  assert.equal(refuseLocal(req('POST', { host: 'localhost:8100', origin: 'http://localhost:8100' })), null); // no body
  assert.equal(refuseLocal(req('POST', { host: '127.0.0.1:8100', 'content-type': 'application/json' })), null); // the hook: no Origin
  assert.equal(refuseLocal(req('POST', { host: 'flightdeck.localhost', origin: 'http://flightdeck.localhost', 'content-type': 'application/json' })), null);
  assert.equal(refuseLocal(req('GET', { host: 'flightdeck.example' })), null); // via /etc/hosts
});

test('other sites, rebinding and form posts are refused', () => {
  assert.notEqual(refuseLocal(req('GET', { host: 'evil.example:8100' })), null); // DNS rebinding
  assert.notEqual(refuseLocal(req('GET', { host: 'localhost.evil.example' })), null);
  assert.notEqual(refuseLocal(req('GET', { host: 'flightdeck.other' })), null); // not a configured name
  assert.notEqual(refuseLocal(req('POST', { host: 'localhost:8100', origin: 'https://evil.example', 'content-type': 'application/json' })), null);
  assert.notEqual(refuseLocal(req('POST', { host: 'localhost:8100', origin: 'null' })), null); // sandboxed iframe / file:
  assert.notEqual(refuseLocal(req('POST', { host: 'localhost:8100', 'content-type': 'text/plain' })), null); // form, enctype=text/plain
  assert.notEqual(refuseLocal(req('POST', { host: 'localhost:8100', 'content-type': 'application/x-www-form-urlencoded' })), null);
});
