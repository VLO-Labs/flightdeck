import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGroups, parseEtime, parseLsof, parsePs, shortCommand } from './processes.ts';

test('ps elapsed time', () => {
  assert.equal(parseEtime('00:07'), 7);
  assert.equal(parseEtime('03:28'), 208);
  assert.equal(parseEtime('01:02:03'), 3723);
  assert.equal(parseEtime('2-00:00:01'), 172801);
});

const PS = `
  100     1 10:00 php /opt/homebrew/bin/composer dev
  101   100 10:00 node /p/node_modules/.bin/multiplex
  102   101 10:00 php -S 127.0.0.1:8000 server.php
  103   101 10:00 node /p/node_modules/.bin/vite
  200     1 50:00 -zsh
  201   200 02:00 npm run watch
  300     1 01:00 node /fd/src/server/main.ts
  301   300 00:30 claude -p hi
  302   301 00:20 /bin/zsh -c sleep 100
  303   302 00:20 sleep 100
  400     1 00:01 grep -r foo .
  500     1 20:00 node elsewhere.js`;
const CWD = parseLsof(['p100', 'n/p', 'p101', 'n/p', 'p102', 'n/p', 'p103', 'n/p', 'p200', 'n/p', 'p201', 'n/p/web',
  'p300', 'n/fd', 'p301', 'n/p', 'p302', 'n/p', 'p303', 'n/p', 'p400', 'n/p', 'p500', 'n/other'].join('\n'));
const LISTEN = parseLsof('p102\nn127.0.0.1:8000\np103\nn[::1]:5173\np500\nn*:9000');

test('one group per tree running in the project, with its ports', () => {
  const groups = buildGroups(parsePs(PS), CWD, LISTEN, ['/p'], 300);
  assert.deepEqual(groups.map(g => [g.pid, g.command, g.ports]), [
    [100, 'php composer dev', [5173, 8000]], // a server: first
    [201, 'npm run watch', []], // started from a terminal: the shell itself isn't listed
  ]);
  assert.deepEqual(groups[0]!.pids.sort(), [100, 101, 102, 103]);
});

test("Flightdeck's own turns, one-off commands and other folders are left out", () => {
  const pids = buildGroups(parsePs(PS), CWD, LISTEN, ['/p'], 300).flatMap(g => g.pids);
  for (const p of [301, 302, 303, 400, 500]) assert.equal(pids.includes(p), false, String(p));
});

test('absolute paths are shortened', () => {
  assert.equal(shortCommand('/usr/bin/php /opt/homebrew/bin/composer dev'), 'php composer dev');
});
