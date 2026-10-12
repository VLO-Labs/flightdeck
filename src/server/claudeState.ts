// What Claude Code last told us that isn't about one chat: the plan's usage limits (account-wide,
// from any turn in any project) and, per project, the commands and skills it has. Kept in a small
// file in the data folder so a restart doesn't forget them until the next turn.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import type { ReportedCommands } from '../shared/commands.ts';

export type Limits = { at: string; info: Record<string, unknown> };
type State = { limits?: Limits; commands: Record<string, ReportedCommands> };

const file = () => join(config.dataDir, 'claude-state.json');
let state: State | undefined;

function load(): State {
  if (state) return state;
  try { state = { commands: {}, ...JSON.parse(readFileSync(file(), 'utf8')) }; } catch { state = { commands: {} }; }
  return state!;
}

function save() {
  try {
    writeFileSync(file() + '.tmp', JSON.stringify(state));
    renameSync(file() + '.tmp', file());
  } catch { /* not essential: the next turn reports again */ }
}

export const latestLimits = () => load().limits;
export const projectCommands = (projectId: number) => load().commands[projectId];

export function recordLimits(info: unknown, at: string) {
  if (!info || typeof info !== 'object') return;
  load().limits = { at, info: info as Record<string, unknown> };
  save();
}

export function recordCommands(projectId: number, ev: Record<string, unknown>) {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  if (!Array.isArray(ev.slash_commands)) return;
  load().commands[projectId] = { commands: list(ev.slash_commands), skills: list(ev.skills), terminal: list(ev.terminal_slash_commands) };
  save();
}
