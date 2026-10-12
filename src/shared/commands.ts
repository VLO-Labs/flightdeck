// Claude Code's slash commands, as Flightdeck offers them. A message that starts with one goes to the
// CLI as-is (no Flightdeck preamble in front, or the CLI would read it as text). The CLI reports what
// it has at the start of each turn: its built-ins and the skills installed for you and the project.
// Skills are offered as they come; built-ins only when they work in a headless turn (tested on
// Claude Code 2.1.296), and the ones that would fight Flightdeck's own controls are refused.

export type ReportedCommands = { commands: string[]; skills: string[]; terminal?: string[] };
export type MenuCommand = { name: string; description?: string; skill?: boolean };

// Built-ins that answer sensibly in a headless turn.
export const BUILTIN_COMMANDS: Record<string, string> = {
  compact: 'Summarise the conversation so far to free up context (text after it steers the summary)',
  context: 'How full the context is, by category',
  usage: 'Your plan’s usage: this session and this week',
  recap: 'A short recap of this conversation',
  init: 'Write a CLAUDE.md for this project (Build mode)',
  'security-review': 'Security review of the changes on this branch',
  mcp: 'Which MCP servers are connected',
  'skill-doctor': 'The skills loaded and what they cost in context',
  insights: 'A report on how you use Claude Code',
};

// Refused, with what to do instead. Settings commands would change your Claude Code setup for every
// session, not this chat; terminal ones need the interactive screen.
const SETTINGS = 'It changes Claude Code’s settings — use it in the terminal.';
const TERMINAL = 'It only works in Claude Code in the terminal.';
export const BLOCKED_COMMANDS: Record<string, string> = {
  clear: 'Start a new chat instead (+ New chat): Flightdeck keeps each chat’s conversation.',
  model: 'Use the model picker at the top of the chat.',
  config: SETTINGS, fast: SETTINGS, effort: SETTINGS, 'output-style': SETTINGS, autocompact: SETTINGS,
  advisor: SETTINGS, color: TERMINAL, focus: TERMINAL, doctor: TERMINAL, 'reload-plugins': TERMINAL,
  'reload-skills': TERMINAL, heapdump: TERMINAL, rename: TERMINAL, agents: TERMINAL,
  'list-agents': TERMINAL, goal: TERMINAL,
  loop: 'Each Flightdeck turn ends when Claude answers, so there is nothing to keep looping.',
  schedule: 'Each Flightdeck turn ends when Claude answers, so there is nothing to schedule into.',
  ultrareview: 'It starts a billed cloud review — run it from Claude Code in the terminal.',
};

// "/name rest…" → the command; anything else is a plain message.
export function parseCommand(text: string): { name: string; args: string } | null {
  const m = /^\/([A-Za-z0-9][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1]!, args: (m[2] ?? '').trim() } : null;
}

export function blockedReason(name: string, reported?: ReportedCommands): string | undefined {
  if (BLOCKED_COMMANDS[name]) return BLOCKED_COMMANDS[name];
  if (name.startsWith('_') || reported?.terminal?.includes(name)) return TERMINAL;
  return undefined;
}

// What the composer's "/" menu offers: the working built-ins (those the CLI reported, or all of them
// before any turn has said), then the skills.
export function commandMenu(reported?: ReportedCommands): MenuCommand[] {
  const builtins = Object.entries(BUILTIN_COMMANDS)
    .filter(([name]) => !reported || reported.commands.includes(name))
    .map(([name, description]) => ({ name, description }));
  const skills = [...new Set(reported?.skills ?? [])]
    .filter(name => !BUILTIN_COMMANDS[name] && !blockedReason(name, reported))
    .sort((a, b) => Number(a.includes(':')) - Number(b.includes(':')) || a.localeCompare(b))
    .map(name => ({ name, skill: true }));
  return [...builtins, ...skills];
}

// The menu narrowed to what's typed after "/": names starting with it first, then names containing it.
export function matchCommands(menu: MenuCommand[], typed: string): MenuCommand[] {
  const q = typed.toLowerCase();
  const starts = menu.filter(c => c.name.toLowerCase().startsWith(q));
  const contains = menu.filter(c => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
  return [...starts, ...contains];
}
