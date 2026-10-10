// Runs one chat turn = one `claude -p` process (spike-verified mechanics, see PLAN.md §4).
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { eq } from 'drizzle-orm';
import { ClaudeEvent } from '../shared/contracts.ts';
import { config } from './config.ts';
import { db, chats, projects, runs } from './db.ts';
import * as feed from './feed.ts';
import { cancelPendingForRun, releaseLockForChat } from './hook.ts';

type Active = { runId: number; chatId: number; projectId: number; proc: ChildProcess; stopRequested: boolean };
const active = new Map<number, Active>(); // by chatId

export const isRunning = (chatId: number) => active.has(chatId);
export const activeRunForSession = (sessionId: string) => {
  const chat = db.select().from(chats).where(eq(chats.sessionId, sessionId)).get();
  if (!chat) return undefined;
  const a = active.get(chat.id);
  return a ? { ...a, chat } : undefined;
};

const now = () => new Date().toISOString();

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
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

export function startTurn(chatId: number, text: string): { ok: true } | { ok: false; error: string } {
  if (active.has(chatId)) return { ok: false, error: 'this chat is already running' };
  const chat = db.select().from(chats).where(eq(chats.id, chatId)).get();
  if (!chat) return { ok: false, error: 'no such chat' };
  const project = db.select().from(projects).where(eq(projects.id, chat.projectId)).get();
  if (!project) return { ok: false, error: 'no such project' };

  const run = db
    .insert(runs)
    .values({ chatId, status: 'running', headBefore: gitHead(project.path), startedAt: now() })
    .returning()
    .get();

  const args = [
    '-p', text,
    chat.started ? '--resume' : '--session-id', chat.sessionId,
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--settings', hookSettings(),
    '--model', chat.model,
  ];

  // stdin closed: otherwise the CLI waits 3 s for piped input and prints a non-JSON warning.
  const proc = spawn(config.claudeBin, args, { cwd: project.path, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  const a: Active = { runId: run.id, chatId, projectId: project.id, proc, stopRequested: false };
  active.set(chatId, a);
  if (!chat.started) db.update(chats).set({ started: true }).where(eq(chats.id, chatId)).run();

  feed.append(chatId, { kind: 'user', at: now(), runId: run.id, text });
  feed.append(chatId, { kind: 'run', at: now(), runId: run.id, status: 'started' });

  let resultSeen = false;
  let failure: string | undefined;
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
      setTimeout(() => proc.exitCode === null && proc.kill('SIGINT'), 2000);
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
    const detail = failure ?? (!resultSeen && !a.stopRequested ? `claude exited (${code}) without a result. ${stderr.trim()}`.trim() : undefined);
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
