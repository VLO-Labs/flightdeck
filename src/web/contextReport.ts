// /context's report, read into parts the chat can lay out plainly. Claude Code prints it as Markdown:
// "## Context Usage", the model and token lines, a category table, then detail sections (MCP tools,
// memory files, skills) that run to a hundred rows. Rows marked "(deferred)" are tool descriptions
// loaded only when a tool is used — they are not in the total. Anything else → null, shown as is.

export type ContextCategory = { name: string; tokens: number; label: string };
export type ContextReport = {
  model?: string; used: number; window: number;
  categories: ContextCategory[]; // what takes context now, largest first
  free: number; buffer: number; // free space; kept free for auto-compaction
  deferred: number; // tool descriptions not loaded yet (not in `used`)
  details: { title: string; rows: number; markdown: string }[];
};

// "154.9k" / "1m" / "717" → tokens.
export function tokenCount(s: string): number {
  const m = /^~?\s*([\d.,]+)\s*([km])?$/i.exec(s.trim());
  if (!m) return NaN;
  const n = Number(m[1]!.replace(/,/g, ''));
  return Math.round(n * (m[2]?.toLowerCase() === 'm' ? 1e6 : m[2]?.toLowerCase() === 'k' ? 1e3 : 1));
}

// What each category is, in plain words.
const LABELS: Record<string, string> = {
  Messages: 'Conversation (messages and tool results)',
  'System prompt': 'System prompt',
  'System tools': 'Built-in tools',
  'MCP tools': 'MCP tools in use',
  'MCP server instructions': 'MCP server instructions',
  'Memory files': 'Memory files (CLAUDE.md)',
  Skills: 'Skill list',
  'Custom agents': 'Agent list',
};

export function parseContextReport(md: string): ContextReport | null {
  if (!/^#+\s*Context Usage/m.test(md)) return null;
  const tokensLine = /\*\*Tokens:\*\*\s*([\d.,]+[km]?)\s*\/\s*([\d.,]+[km]?)/i.exec(md);
  if (!tokensLine) return null;
  const used = tokenCount(tokensLine[1]!);
  const window = tokenCount(tokensLine[2]!);
  const model = /\*\*Model:\*\*\s*(\S+)/.exec(md)?.[1];

  // Sections by "### " heading; the first is the category table.
  const sections = md.split(/^###\s+/m).slice(1).map(s => {
    const nl = s.indexOf('\n');
    return { title: s.slice(0, nl).trim(), body: s.slice(nl + 1).trim() };
  });
  const tableRows = (body: string) => body.split('\n')
    .filter(l => /^\|/.test(l) && !/^\|\s*-/.test(l))
    .slice(1) // the header
    .map(l => l.split('|').slice(1, -1).map(c => c.trim()));
  const cats = sections.find(s => /usage by category/i.test(s.title));
  if (!cats || !Number.isFinite(used) || !Number.isFinite(window)) return null;

  const report: ContextReport = { model, used, window, categories: [], free: 0, buffer: 0, deferred: 0, details: [] };
  for (const [name = '', tok = ''] of tableRows(cats.body)) {
    const tokens = tokenCount(tok);
    if (!Number.isFinite(tokens)) continue;
    if (/deferred/i.test(name)) report.deferred += tokens;
    else if (/^free space$/i.test(name)) report.free = tokens;
    else if (/autocompact buffer/i.test(name)) report.buffer = tokens;
    else if (tokens > 0) report.categories.push({ name, tokens, label: LABELS[name] ?? name });
  }
  report.categories.sort((a, b) => b.tokens - a.tokens);
  report.details = sections.filter(s => s !== cats).map(s => ({ title: s.title, rows: tableRows(s.body).length, markdown: s.body }));
  return report;
}
