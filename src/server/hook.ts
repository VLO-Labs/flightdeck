// The PreToolUse hook: Claude Code calls this before every tool use and waits for the answer.
// Order of decisions: edit lock → the project's rules → (Ask) an approval card you click.
import { and, eq } from 'drizzle-orm';
import type { Decision, FeedItem, HookPayload } from '../shared/contracts.ts';
import { config } from './config.ts';
import { db, approvals, projects, rules } from './db.ts';
import * as feed from './feed.ts';
import { EDIT_TOOLS, evaluate, suggestPattern } from './rules.ts';
import { activeRunForSession } from './runner.ts';

type Answer = { decision: 'allow' | 'deny'; reason: string };
type ApprovalItem = Extract<FeedItem, { kind: 'approval' }>;
type Pending = { chatId: number; runId: number; projectId: number; item: ApprovalItem; resolve: (a: Answer) => void; timer: NodeJS.Timeout };

const pending = new Map<number, Pending>(); // by approval id
const editLocks = new Map<number, number>(); // projectId → chatId holding the lock

const now = () => new Date().toISOString();

export const lockHolder = (projectId: number) => editLocks.get(projectId);
export function releaseLockForChat(chatId: number) {
  for (const [p, c] of editLocks) if (c === chatId) editLocks.delete(p);
}

function record(runId: number, p: HookPayload, decision: 'pending' | 'allowed' | 'denied', decidedBy?: string, rule?: string, reason?: string) {
  return db
    .insert(approvals)
    .values({
      runId, toolName: p.tool_name, toolInput: JSON.stringify(p.tool_input), decision,
      decidedBy, rule, reason, createdAt: now(), decidedAt: decision === 'pending' ? null : now(),
    })
    .returning()
    .get();
}

function settle(id: number, chatId: number, item: ApprovalItem, a: Answer, decidedBy: ApprovalItem['decidedBy']) {
  const state = a.decision === 'allow' ? 'allowed' : 'denied';
  db.update(approvals)
    .set({ decision: state, decidedBy, reason: a.reason, decidedAt: now() })
    .where(eq(approvals.id, id))
    .run();
  feed.append(chatId, { ...item, at: now(), state, decidedBy, reason: a.reason });
}

export function hookResponse(a: Answer) {
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: a.decision, permissionDecisionReason: a.reason },
  };
}

export async function decide(p: HookPayload): Promise<Answer> {
  const run = activeRunForSession(p.session_id);
  if (!run) return { decision: 'deny', reason: 'Flightdeck has no running chat for this session' };
  const project = db.select().from(projects).where(eq(projects.id, run.projectId)).get()!;

  const base: ApprovalItem = {
    kind: 'approval', at: now(), runId: run.runId, approvalId: 0, toolName: p.tool_name,
    toolInput: p.tool_input, toolUseId: p.tool_use_id, state: 'pending',
  };

  const isEdit = EDIT_TOOLS.has(p.tool_name);

  // 0. Discuss mode never edits, whatever the rules say.
  if (isEdit && run.mode === 'discuss') {
    const reason = 'This chat is in Discuss mode, so file edits are refused. Propose the change instead; the user switches the chat to Build to implement it.';
    const row = record(run.runId, p, 'denied', 'mode', undefined, reason);
    feed.append(run.chatId, { ...base, approvalId: row.id, state: 'denied', decidedBy: 'mode', reason });
    return { decision: 'deny', reason };
  }

  // 1. The edit lock: one chat per project may change code.
  const holder = editLocks.get(project.id);
  if (isEdit && holder !== undefined && holder !== run.chatId) {
    const reason = 'Another chat in this project is changing code right now. Wait for it to finish, then try again.';
    const row = record(run.runId, p, 'denied', 'lock', undefined, reason);
    feed.append(run.chatId, { ...base, approvalId: row.id, state: 'denied', decidedBy: 'lock', reason });
    return { decision: 'deny', reason };
  }
  const takeLock = () => isEdit && editLocks.set(project.id, run.chatId);

  // 2. The project's rules.
  const projectRules = db.select().from(rules).where(eq(rules.projectId, project.id)).all();
  const verdict = evaluate(projectRules, p.tool_name, p.tool_input, project.path);

  if (verdict.bucket === 'allow') {
    record(run.runId, p, 'allowed', 'rule', verdict.rule?.pattern);
    takeLock();
    return { decision: 'allow', reason: `allowed by rule ${verdict.rule?.pattern}` };
  }
  if (verdict.bucket === 'deny') {
    const reason = verdict.rule?.reason ?? `denied by rule ${verdict.rule?.pattern}`;
    const row = record(run.runId, p, 'denied', 'rule', verdict.rule?.pattern, reason);
    feed.append(run.chatId, { ...base, approvalId: row.id, state: 'denied', decidedBy: 'rule', rule: verdict.rule?.pattern, reason });
    return { decision: 'deny', reason };
  }

  // 3. Ask: show a card and hold Claude Code until you click (or the card times out).
  const row = record(run.runId, p, 'pending');
  const item: ApprovalItem = { ...base, approvalId: row.id, suggestedPattern: suggestPattern(p.tool_name, p.tool_input) };
  feed.append(run.chatId, item);

  const answer = await new Promise<Answer>(resolve => {
    const timer = setTimeout(() => {
      pending.delete(row.id);
      const a: Answer = { decision: 'deny', reason: 'No answer in time — the approval card expired.' };
      settle(row.id, run.chatId, item, a, 'timeout');
      resolve(a);
    }, config.approvalTimeoutS * 1000);
    pending.set(row.id, { chatId: run.chatId, runId: run.runId, projectId: project.id, item, resolve, timer });
  });
  if (answer.decision === 'allow') takeLock();
  return answer;
}

// A click on a card.
export function resolveApproval(id: number, d: Decision): boolean {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  clearTimeout(p.timer);

  if (d.decision === 'allow' && d.alwaysAllowPattern) {
    const { projectId } = p;
    const exists = db.select().from(rules)
      .where(and(eq(rules.projectId, projectId), eq(rules.pattern, d.alwaysAllowPattern), eq(rules.bucket, 'allow'))).get();
    if (!exists) db.insert(rules).values({ projectId, bucket: 'allow', pattern: d.alwaysAllowPattern, reason: 'added from an approval card' }).run();
  }
  const a: Answer = d.decision === 'allow'
    ? { decision: 'allow', reason: d.alwaysAllowPattern ? `allowed by you (and saved as ${d.alwaysAllowPattern})` : 'allowed by you' }
    : { decision: 'deny', reason: d.reason?.trim() ? `Denied by the user: ${d.reason.trim()}` : 'Denied by the user.' };
  settle(id, p.chatId, p.item, a, 'user');
  p.resolve(a);
  return true;
}

// When a run ends or is stopped, any card still open is moot: deny it so nothing waits forever.
export function cancelPendingForRun(runId: number, reason: string) {
  for (const [id, p] of pending) {
    if (p.runId !== runId) continue;
    pending.delete(id);
    clearTimeout(p.timer);
    const a: Answer = { decision: 'deny', reason: `Approval cancelled: ${reason}.` };
    settle(id, p.chatId, p.item, a, 'timeout');
    p.resolve(a);
  }
}
