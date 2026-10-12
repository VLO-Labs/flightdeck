import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockedReason, commandMenu, matchCommands, parseCommand } from './commands.ts';

test('a message is a command only when it starts with /name', () => {
  assert.deepEqual(parseCommand('/compact'), { name: 'compact', args: '' });
  assert.deepEqual(parseCommand('  /compact keep the plan details\nand the file list '), { name: 'compact', args: 'keep the plan details\nand the file list' });
  assert.deepEqual(parseCommand('/anthropic-skills:pdf a.pdf'), { name: 'anthropic-skills:pdf', args: 'a.pdf' });
  // A path at the start is a message, not a command.
  for (const t of ['compact', 'see /compact', '/', '/ compact', '//x', '/src/app.ts is broken']) assert.equal(parseCommand(t), null, t);
});

test('commands that fight Flightdeck are refused, with what to do instead', () => {
  assert.match(blockedReason('clear')!, /New chat/);
  assert.match(blockedReason('model')!, /model picker/);
  assert.ok(blockedReason('__remote-workflow'));
  assert.ok(blockedReason('focus-mode', { commands: [], skills: [], terminal: ['focus-mode'] }));
  assert.equal(blockedReason('compact'), undefined);
  assert.equal(blockedReason('code-review'), undefined);
});

test('the menu: working built-ins the CLI reported, then skills (own before plugin ones)', () => {
  const menu = commandMenu({
    commands: ['compact', 'clear', 'context', 'model', 'code-review', 'loop', 'anthropic-skills:pdf'],
    skills: ['anthropic-skills:pdf', 'code-review', 'loop', 'debug'],
  });
  assert.deepEqual(menu.map(c => c.name), ['compact', 'context', 'code-review', 'debug', 'anthropic-skills:pdf']);
  assert.ok(menu[0]!.description && !menu[0]!.skill && menu[2]!.skill);
  // Before any turn has reported, all the working built-ins.
  assert.ok(commandMenu().some(c => c.name === 'usage'));
  assert.deepEqual(matchCommands(menu, 'co').map(c => c.name), ['compact', 'context', 'code-review']);
  assert.deepEqual(matchCommands(menu, 'pdf').map(c => c.name), ['anthropic-skills:pdf']);
});
