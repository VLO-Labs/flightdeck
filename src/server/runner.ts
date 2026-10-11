// Runs one chat turn = one `claude -p` process (spike-verified mechanics, see PLAN.md §4).
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createInterface } from 'node:readline';
import { eq } from 'drizzle-orm';
import { ClaudeEvent, type Mode } from '../shared/contracts.ts';
import { config } from './config.ts';
import { db, chats, projects, runs } from './db.ts';
import * as feed from './feed.ts';
import { cancelPendingForRun, releaseLockForChat } from './hook.ts';
import { MCP_SERVER } from './mcp.ts';
import { approvedVersion, currentMaps, planStatusLine } from './plans.ts';
import { planAsText } from '../shared/plan.ts';

type Active = {
  runId: number; chatId: number; projectId: number; mode: Mode; proc: ChildProcess; stopRequested: boolean;
  mcpToken?: string; // Discuss turns: what this run's calls to Flightdeck's MCP tools must carry
};
const active = new Map<number, Active>(); // by chatId

export const isRunning = (chatId: number) => active.has(chatId);
// The run a token was issued to, while that run is still going.
export const activeRunForMcpToken = (token: string) => {
  for (const a of active.values()) {
    if (a.mcpToken && a.mcpToken.length === token.length && timingSafeEqual(Buffer.from(a.mcpToken), Buffer.from(token))) return a;
  }
  return undefined;
};
export const activeRunForSession = (sessionId: string) => {
  const chat = db.select().from(chats).where(eq(chats.sessionId, sessionId)).get();
  if (!chat) return undefined;
  const a = active.get(chat.id);
  return a ? { ...a, chat } : undefined;
};

const now = () => new Date().toISOString();

// Discuss mode is enforced by the hook (edits are refused); this tells the agent up front, so it
// plans instead of trying edits and hitting refusals.
const DISCUSS_PROMPT =
  'You are in Flightdeck DISCUSS mode. Read the code, analyze, answer questions and propose plans, ' +
  'but do not modify files or run commands that change state — file edits will be refused. When a ' +
  'plan is ready, say so: the user switches the chat to BUILD mode to implement it, and you will ' +
  'keep this conversation as context.\n\n' +
  'When a change affects the structure (new or changed parts, data, or flows), also propose it with the ' +
  'flightdeck propose_plan tool: Flightdeck draws it over the project map for the user to review and ' +
  'approve. Base it on the current maps: get_maps returns their node ids. When the user asks for ' +
  'changes to the plan, call the tool again with the whole revised plan; if they ask to drop it, use ' +
  'drop_plan. You cannot approve a plan: the user does that in Flightdeck. Keep your text reply short: ' +
  'the user reads the plan on the map.';

// Every turn states its mode: a resumed session still holds the earlier Discuss turns (and the
// agent's own "switch to Build to implement" replies), so without this a Build turn reads as Discuss.
const BUILD_PROMPT =
  'You are in Flightdeck BUILD mode. You may edit files and run commands to implement what the user ' +
  'asks. If earlier turns in this conversation were in DISCUSS mode, the user has since switched the ' +
  'chat to BUILD: those read-only limits no longer apply, so go ahead and implement.';

// With an approved plan, Build implements that version (PLAN.md §10) — not whatever was said after it.
const PLAN_PROMPT =
  'This chat has an APPROVED PLAN, below. It is the spec for this work: implement it, following its ' +
  'steps in order. If the code turns out not to fit the plan, or a decision it needs is missing, stop ' +
  'and say so plainly instead of improvising a different design; the user revises the plan in Discuss ' +
  'and approves the new version. Do not edit the map files in .flightdeck/; they are regenerated from ' +
  'the code.';

export function effectiveModel(
  chat: typeof chats.$inferSelect, project: typeof projects.$inferSelect, mode: Mode,
): string {
  return mode === 'build' ? chat.buildModel ?? project.buildModel : chat.discussModel ?? project.discussModel;
}

function gitHead(path: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

// The hook config passed with --settings. Every tool call goes through Flightdeck.
function hookSettings(): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'http',
              url: `http://${config.host}:${config.port}/hook`,
              // A minute above Flightdeck's own card timeout, so Flightdeck always answers first.
              timeout: config.approvalTimeoutS + 60,
              // If the hook fails anyway (Flightdeck down), deny instead of falling back to
              // Claude Code's default rules (which let read-only commands through). ≥ 2.1.295.
              onFailure: 'block',
            },
          ],
        },
      ],
    },
  });
}

// Never let an API key reach the child: in -p mode it silently beats the subscription login.
function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

type ContextNode = { view: string; nodeId: string; label: string; kind: string; summary: string; files: string[] };

// A resumed session keeps the system prompt of its FIRST turn: --append-system-prompt on later turns
// is ignored (seen 2026-10-11, Claude Code 2.1.296). So the turn's mode, and an approved plan, also
// travel in the message itself, every turn. The feed stores only what the user typed.
function modeBlock(prompt: string): string {
  return `[Flightdeck: instructions for this turn — they replace any earlier Flightdeck mode instructions]\n${prompt}\n[End of Flightdeck instructions. The user's message follows.]\n\n`;
}

// The block the agent sees above the user's message for each attached map node — built from the
// map file on disk, so the UI can only point at nodes, never inject text.
function contextBlock(nodes: ContextNode[]): string {
  if (nodes.length === 0) return '';
  const lines = nodes.map(n =>
    `- ${n.label} (${n.kind}, ${n.view} view): ${n.summary}\n  files: ${n.files.join(', ') || '(none recorded)'}`);
  return `[Flightdeck: the user attached these parts of the project map to this message]\n${lines.join('\n')}\n\n`;
}

export function startTurn(chatId: number, text: string, context: ContextNode[] = []): { ok: true } | { ok: false; error: string } {
  if (active.has(chatId)) return { ok: false, error: 'this chat is already running' };
  const chat = db.select().from(chats).where(eq(chats.id, chatId)).get();
  if (!chat) return { ok: false, error: 'no such chat' };
  const project = db.select().from(projects).where(eq(projects.id, chat.projectId)).get();
  if (!project) return { ok: false, error: 'no such project' };

  const mode = chat.mode;
  const model = effectiveModel(chat, project, mode);
  // A Build turn implements the chat's approved plan version, if it has one, and records which.
  const approved = mode === 'build' ? approvedVersion(chatId) : null;
  const run = db
    .insert(runs)
    .values({ chatId, status: 'running', headBefore: gitHead(project.path), startedAt: now(), planVersionId: approved?.id ?? null })
    .returning()
    .get();

  // The agent can't see Flightdeck's UI, so each turn says where the chat's plan stands.
  const prompt = mode === 'discuss' ? `${DISCUSS_PROMPT}\n\n${planStatusLine(chatId)}`
    : approved ? `${BUILD_PROMPT}\n\n${PLAN_PROMPT}\n\n${planAsText(approved.body, approved.version, currentMaps(project))}`
    : `${BUILD_PROMPT}\n\n${planStatusLine(chatId)}`;
  const args = [
    '-p', modeBlock(prompt) + contextBlock(context) + text,
    chat.started ? '--resume' : '--session-id', chat.sessionId,
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--settings', hookSettings(),
    '--model', model,
  ];
  args.push('--append-system-prompt', prompt);

  // Discuss turns get Flightdeck's propose_plan tool, behind a token only this run holds. The token
  // reaches the CLI through the environment (the config refers to it), not the command line.
  const mcpToken = mode === 'discuss' ? randomBytes(32).toString('hex') : undefined;
  if (mcpToken) {
    args.push('--mcp-config', JSON.stringify({ mcpServers: { [MCP_SERVER]: {
      type: 'http', url: `http://${config.host}:${config.port}/mcp`,
      headers: { Authorization: 'Bearer ${FLIGHTDECK_MCP_TOKEN}' },
    } } }));
  }

  // stdin closed: otherwise the CLI waits 3 s for piped input and prints a non-JSON warning.
  const env = childEnv(mcpToken ? { FLIGHTDECK_MCP_TOKEN: mcpToken } : {});
  const proc = spawn(config.claudeBin, args, { cwd: project.path, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const a: Active = { runId: run.id, chatId, projectId: project.id, mode, proc, stopRequested: false, mcpToken };
  active.set(chatId, a);
  if (!chat.started) db.update(chats).set({ started: true }).where(eq(chats.id, chatId)).run();

  feed.append(chatId, {
    kind: 'user', at: now(), runId: run.id, text, mode, model,
    context: context.length ? context.map(c => ({ view: c.view, nodeId: c.nodeId, label: c.label })) : undefined,
  });
  feed.append(chatId, { kind: 'run', at: now(), runId: run.id, status: 'started' });

  let resultSeen = false;
  let failure: string | undefined;
  let endTimer: NodeJS.Timeout | undefined;
  let stderr = '';
  proc.stderr!.on('data', d => (stderr += d.toString()).length > 4000 && (stderr = stderr.slice(-4000)));

  createInterface({ input: proc.stdout! }).on('line', line => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return; // non-JSON noise (warnings) — not part of the stream contract
    }
    const parsed = ClaudeEvent.safeParse(raw);
    if (!parsed.success) return;
    const ev = parsed.data as ClaudeEvent;

    // A resumed session whose last turn left a background task running first replays a stale,
    // empty result, then inits again for the real turn. That result didn't end this turn.
    if (ev.type === 'system' && ev.subtype === 'init' && resultSeen) {
      clearTimeout(endTimer);
      resultSeen = false;
      failure = undefined;
    }
    // Tripwire: anything but the subscription login aborts the run before it does any work.
    if (ev.type === 'system' && ev.subtype === 'init' && ev.apiKeySource !== 'none') {
      failure = `refused: session is not on the subscription (apiKeySource=${String(ev.apiKeySource)})`;
      proc.kill('SIGINT');
      return;
    }
    feed.append(chatId, { kind: 'claude', at: now(), runId: run.id, event: ev });

    if (ev.type === 'result') {
      resultSeen = true;
      // Judge by is_error, never by subtype (a bad-key run reports subtype "success").
      if (ev.is_error) failure = typeof ev.result === 'string' ? ev.result : `run ended with ${ev.subtype}`;
      // `result` ends the turn but background tasks keep the process alive; Phase 1 ends them.
      endTimer = setTimeout(() => proc.exitCode === null && proc.kill('SIGINT'), 2000);
    }
  });

  proc.on('error', err => (failure = `could not start claude: ${err.message}`));
  proc.on('close', code => {
    active.delete(chatId);
    releaseLockForChat(chatId);
    cancelPendingForRun(run.id, 'the run ended');
    let status: 'finished' | 'failed' | 'stopped';
    if (a.stopRequested) status = 'stopped';
    else if (failure || !resultSeen) status = 'failed';
    else status = 'finished';
    // A stop ends the turn with error_during_execution by design; that's not a failure to report.
    const detail = a.stopRequested
      ? undefined
      : failure ?? (!resultSeen ? `claude exited (${code}) without a result. ${stderr.trim()}`.trim() : undefined);
    db.update(runs)
      .set({ status, detail, endedAt: now(), headAfter: gitHead(project.path) })
      .where(eq(runs.id, run.id))
      .run();
    feed.append(chatId, { kind: 'run', at: now(), runId: run.id, status, detail });
  });

  return { ok: true };
}

// The stop button: SIGINT ends the turn cleanly and records it (SIGTERM would leave it unrecorded).
export function stopTurn(chatId: number): boolean {
  const a = active.get(chatId);
  if (!a) return false;
  a.stopRequested = true;
  cancelPendingForRun(a.runId, 'stopped by you');
  a.proc.kill('SIGINT');
  return true;
}
