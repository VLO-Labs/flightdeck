// Per-project approval rules: every tool call lands in allow / ask / deny.
// Syntax follows Claude Code's own rules so they mean the same thing as in the terminal:
//   Read                     any call to the tool
//   mcp__*                   tool-name glob
//   Bash(git status:*)       a command that is `git status` or starts with `git status `
//   Bash(npm run *)          a command glob
//   WebFetch(domain:x.com)   x.com or any subdomain
//   Edit(src/**)             a path glob (relative to the project, or absolute)
// Precedence is Deny > Ask > Allow, and a call no rule matches is Ask.
import { relative, isAbsolute } from 'node:path';
import type { Bucket, NewRule } from '../shared/contracts.ts';

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

type RuleLike = { bucket: Bucket; pattern: string; reason: string | null };
export type Verdict = { bucket: Bucket; rule?: RuleLike };

const RANK: Record<Bucket, number> = { allow: 0, ask: 1, deny: 2 };

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*';
    } else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// For command globs `*` must cross `/` too (paths appear inside commands).
function commandGlob(glob: string): RegExp {
  return new RegExp(`^${glob.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's');
}

export function parsePattern(pattern: string): { tool: string; spec?: string } {
  const m = /^([^()]+?)(?:\((.*)\))?$/s.exec(pattern.trim());
  if (!m) return { tool: pattern.trim() };
  return { tool: m[1]!.trim(), spec: m[2]?.trim() };
}

// Split a shell command into the commands it actually runs. Naive about quoting on purpose:
// over-splitting only produces fragments that match no Allow rule, which makes a call *stricter*.
export function splitCommand(cmd: string): string[] {
  return cmd.split(/&&|\|\||;|\||&|\n/).map(s => s.trim()).filter(Boolean);
}

// Constructs that hide a second command inside the first. A prefix rule must never wave these through.
const HIDDEN_EXEC = /\$\(|`|<\(|>\(/;

function matchBashSpec(spec: string, command: string): boolean {
  if (spec.endsWith(':*')) {
    const prefix = spec.slice(0, -2);
    return command === prefix || command.startsWith(prefix + ' ');
  }
  if (spec.includes('*')) return commandGlob(spec).test(command);
  return command === spec;
}

function pathOf(input: Record<string, unknown>): string | undefined {
  for (const k of ['file_path', 'notebook_path', 'path']) {
    const v = input[k];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

// Does one rule cover one (sub)call? `command` is set for Bash, already split.
function ruleMatches(
  pattern: string,
  toolName: string,
  input: Record<string, unknown>,
  projectPath: string,
  command?: string,
): boolean {
  const { tool, spec } = parsePattern(pattern);
  if (!globToRegExp(tool).test(toolName)) return false;
  if (spec === undefined || spec === '' || spec === '*') return true;

  if (toolName === 'Bash') return command !== undefined && matchBashSpec(spec, command);

  if (spec.startsWith('domain:')) {
    const domain = spec.slice('domain:'.length).toLowerCase();
    try {
      const host = new URL(String(input.url ?? '')).hostname.toLowerCase();
      return host === domain || host.endsWith('.' + domain);
    } catch {
      return false;
    }
  }

  const p = pathOf(input);
  if (p === undefined) return false;
  const re = globToRegExp(spec);
  if (re.test(p)) return true;
  const rel = isAbsolute(p) ? relative(projectPath, p) : p;
  return !rel.startsWith('..') && re.test(rel);
}

function strongest(rules: RuleLike[], match: (r: RuleLike) => boolean): Verdict {
  let best: Verdict = { bucket: 'ask' }; // no rule matched
  let matched = false;
  for (const r of rules) {
    if (!match(r)) continue;
    if (!matched || RANK[r.bucket] > RANK[best.bucket]) best = { bucket: r.bucket, rule: r };
    matched = true;
  }
  return best;
}

export function evaluate(
  rules: RuleLike[],
  toolName: string,
  input: Record<string, unknown>,
  projectPath: string,
): Verdict {
  if (toolName !== 'Bash') {
    return strongest(rules, r => ruleMatches(r.pattern, toolName, input, projectPath));
  }

  const command = String(input.command ?? '');
  const parts = splitCommand(command);
  if (parts.length === 0) return { bucket: 'ask' };

  // Every part must be allowed for the whole to be allowed; any denied part denies the whole.
  let overall: Verdict = { bucket: 'allow' };
  for (const part of parts) {
    const v = strongest(rules, r => ruleMatches(r.pattern, 'Bash', input, projectPath, part));
    if (RANK[v.bucket] > RANK[overall.bucket] || (overall.bucket === 'allow' && !overall.rule)) overall = v;
  }
  if (overall.bucket === 'allow' && HIDDEN_EXEC.test(command)) return { bucket: 'ask' };
  return overall;
}

// What "Always allow" proposes for a call (the user sees and can edit it before it's saved).
export function suggestPattern(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash') {
    const first = splitCommand(String(input.command ?? ''))[0] ?? '';
    const words = first.split(/\s+/);
    // Keep a second word only when it looks like a subcommand (`git commit`, `npm test`),
    // not an argument such as a file name or a flag.
    const sub = words[1] && /^[a-z][a-z0-9-]*$/.test(words[1]);
    const head = sub ? `${words[0]} ${words[1]}` : words[0];
    return `Bash(${head}:*)`;
  }
  if (toolName === 'WebFetch') {
    try {
      return `WebFetch(domain:${new URL(String(input.url)).hostname})`;
    } catch {
      return 'WebFetch';
    }
  }
  return toolName;
}

// Every new project starts from this; it's then the project's own, edited in its settings.
// Bash and WebFetch are Ask by default for a second reason: they are the agent's only ways to
// reach the network — including Flightdeck's own API on loopback.
export const TEMPLATE_RULES: NewRule[] = [
  { bucket: 'allow', pattern: 'Read', reason: null },
  { bucket: 'allow', pattern: 'Glob', reason: null },
  { bucket: 'allow', pattern: 'Grep', reason: null },
  { bucket: 'allow', pattern: 'LS', reason: null },
  { bucket: 'allow', pattern: 'TodoWrite', reason: null },
  { bucket: 'allow', pattern: 'Edit', reason: 'edits are reviewable and revertible in git' },
  { bucket: 'allow', pattern: 'Write', reason: 'edits are reviewable and revertible in git' },
  { bucket: 'allow', pattern: 'MultiEdit', reason: 'edits are reviewable and revertible in git' },
  { bucket: 'allow', pattern: 'NotebookEdit', reason: 'edits are reviewable and revertible in git' },
  { bucket: 'allow', pattern: 'Bash(git status:*)', reason: null },
  { bucket: 'allow', pattern: 'Bash(git diff:*)', reason: null },
  { bucket: 'allow', pattern: 'Bash(git log:*)', reason: null },
  { bucket: 'allow', pattern: 'Bash(ls:*)', reason: null },
  { bucket: 'deny', pattern: 'Bash(git push --force:*)', reason: 'force-push is never done from Flightdeck' },
  { bucket: 'deny', pattern: 'Bash(git push -f:*)', reason: 'force-push is never done from Flightdeck' },
  { bucket: 'deny', pattern: 'Bash(rm -rf /*)', reason: 'recursive delete outside the repo' },
  { bucket: 'deny', pattern: 'Bash(rm -rf ~*)', reason: 'recursive delete outside the repo' },
  { bucket: 'deny', pattern: 'Bash(make *)', reason: 'deploys are not done from Flightdeck (Phase 1)' },
  { bucket: 'deny', pattern: 'Bash(wrangler deploy:*)', reason: 'deploys are not done from Flightdeck (Phase 1)' },
  { bucket: 'deny', pattern: 'Bash(npx wrangler deploy:*)', reason: 'deploys are not done from Flightdeck (Phase 1)' },
];
