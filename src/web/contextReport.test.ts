import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseContextReport, tokenCount } from './contextReport.ts';

// As Claude Code 2.1.296 prints it (shortened).
const REPORT = `## Context Usage

**Model:** claude-opus-5-5
**Tokens:** 170.9k / 1m (17%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 2.9k | 0.3% |
| System tools | 3k | 0.3% |
| MCP tools | 1.5k | 0.1% |
| MCP server instructions | 717 | 0.1% |
| MCP tools (deferred) | 87.2k | 8.7% |
| System tools (deferred) | 14k | 1.4% |
| Memory files | 800 | 0.1% |
| Skills | 7.1k | 0.7% |
| Messages | 154.9k | 15.5% |
| Free space | 796.1k | 79.6% |
| Autocompact buffer | 33k | 3.3% |

### MCP Tools

| Tool | Server | Tokens |
|------|--------|--------|
| mcp__flightdeck__get_maps | flightdeck | 111 |
| mcp__idea__read_file | idea | 520 |

### Memory Files

| Type | Path | Tokens |
|------|------|--------|
| Project | /x/CLAUDE.md | 800 |
`;

test('token counts as /context prints them', () => {
  assert.equal(tokenCount('154.9k'), 154_900);
  assert.equal(tokenCount('1m'), 1_000_000);
  assert.equal(tokenCount('717'), 717);
  assert.equal(tokenCount('~150'), 150);
  assert.ok(Number.isNaN(tokenCount('n/a')));
});

test('/context: the total, what takes it (deferred tools apart), the details folded', () => {
  const r = parseContextReport(REPORT)!;
  assert.equal(r.model, 'claude-opus-5-5');
  assert.equal(r.used, 170_900);
  assert.equal(r.window, 1_000_000);
  assert.deepEqual(r.categories.map(c => [c.name, c.tokens]), [
    ['Messages', 154_900], ['Skills', 7_100], ['System tools', 3_000], ['System prompt', 2_900],
    ['MCP tools', 1_500], ['Memory files', 800], ['MCP server instructions', 717],
  ]);
  // What's counted adds up to the total; deferred tool descriptions are not part of it.
  assert.equal(r.categories.reduce((s, c) => s + c.tokens, 0), 170_917);
  assert.equal(r.deferred, 101_200);
  assert.equal(r.free, 796_100);
  assert.equal(r.buffer, 33_000);
  assert.deepEqual(r.details.map(d => [d.title, d.rows]), [['MCP Tools', 2], ['Memory Files', 1]]);
  assert.equal(parseContextReport('Current session: 2% used'), null);
});
