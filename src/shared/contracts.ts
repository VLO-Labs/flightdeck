// The contracts shared by server and UI. Everything that crosses the wire is defined here once,
// so a mismatch between the two sides fails the type check instead of failing silently.
import { z } from 'zod';

// ---------------------------------------------------------------------------------------------
// Approval rules
// ---------------------------------------------------------------------------------------------

export const Bucket = z.enum(['allow', 'ask', 'deny']);
export type Bucket = z.infer<typeof Bucket>;

export const Rule = z.object({
  id: z.number(),
  projectId: z.number(),
  bucket: Bucket,
  pattern: z.string(), // Claude Code rule syntax: `Read`, `Bash(git status:*)`, `WebFetch(domain:x.com)`
  reason: z.string().nullable(),
});
export type Rule = z.infer<typeof Rule>;

export const NewRule = Rule.pick({ bucket: true, pattern: true, reason: true });
export type NewRule = z.infer<typeof NewRule>;

// ---------------------------------------------------------------------------------------------
// Projects and chats
// ---------------------------------------------------------------------------------------------

export const Project = z.object({
  id: z.number(),
  name: z.string(),
  path: z.string(),
  discussModel: z.string(), // the project's default for Discuss turns
  buildModel: z.string(), // …and for Build turns
  createdAt: z.string(),
});
export type Project = z.infer<typeof Project>;

export const NewProject = z.object({ name: z.string().min(1), path: z.string().min(1) });
export const ProjectSettings = z.object({ discussModel: z.string().min(1), buildModel: z.string().min(1) });

// Discuss: read, analyze, propose — edits are refused. Build: may change code (takes the edit lock).
export const Mode = z.enum(['discuss', 'build']);
export type Mode = z.infer<typeof Mode>;

export const Chat = z.object({
  id: z.number(),
  projectId: z.number(),
  title: z.string(),
  sessionId: z.string(),
  mode: Mode,
  // Effective models (the chat's override, else the project's default) and whether overridden.
  discussModel: z.string(),
  buildModel: z.string(),
  discussModelOverridden: z.boolean(),
  buildModelOverridden: z.boolean(),
  createdAt: z.string(),
  running: z.boolean(),
  holdsEditLock: z.boolean(),
});
export type Chat = z.infer<typeof Chat>;

// The models offered in the chat's picker. Any id the CLI accepts works; these are the menu.
export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
] as const;

export const SendMessage = z.object({ text: z.string().min(1) });
// Change a chat's mode and/or its model for a mode. `null` clears an override (back to the project default).
export const ChatSettings = z.object({
  mode: Mode.optional(),
  discussModel: z.string().min(1).nullable().optional(),
  buildModel: z.string().min(1).nullable().optional(),
});

export const Decision = z.object({
  decision: z.enum(['allow', 'deny']),
  reason: z.string().optional(),
  // "Always allow": also save this pattern as an Allow rule on the project.
  alwaysAllowPattern: z.string().optional(),
});
export type Decision = z.infer<typeof Decision>;

// ---------------------------------------------------------------------------------------------
// What Claude Code sends us
// ---------------------------------------------------------------------------------------------

// The PreToolUse hook body (spike-verified, Claude Code 2.1.289).
export const HookPayload = z.looseObject({
  session_id: z.string(),
  hook_event_name: z.string(),
  tool_name: z.string(),
  tool_input: z.record(z.string(), z.unknown()),
  tool_use_id: z.string().optional(),
  cwd: z.string().optional(),
});
export type HookPayload = z.infer<typeof HookPayload>;

// A line of `--output-format stream-json`. Kept loose on purpose: Claude Code adds event types
// between versions, and an unknown one must be shown/ignored, never crash the run.
export const ClaudeEvent = z.looseObject({
  type: z.string(),
  subtype: z.string().optional(),
});
export type ClaudeEvent = z.infer<typeof ClaudeEvent> & Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// The chat feed: everything a chat shows, in order. Stored one JSON line per item in the chat's
// log file, replayed on reconnect, streamed live over SSE.
// ---------------------------------------------------------------------------------------------

const base = { at: z.string(), runId: z.number() };

export const FeedItem = z.discriminatedUnion('kind', [
  // mode/model: what this turn ran with, so the history shows it.
  z.object({ kind: z.literal('user'), ...base, text: z.string(), mode: Mode.optional(), model: z.string().optional() }),
  z.object({ kind: z.literal('claude'), ...base, event: ClaudeEvent }),
  z.object({
    kind: z.literal('run'),
    ...base,
    status: z.enum(['started', 'finished', 'failed', 'stopped']),
    detail: z.string().optional(),
  }),
  z.object({
    kind: z.literal('approval'),
    ...base,
    approvalId: z.number(),
    toolName: z.string(),
    toolInput: z.record(z.string(), z.unknown()),
    toolUseId: z.string().optional(),
    state: z.enum(['pending', 'allowed', 'denied']),
    decidedBy: z.enum(['user', 'rule', 'timeout', 'lock', 'mode']).optional(),
    rule: z.string().optional(),
    reason: z.string().optional(),
    suggestedPattern: z.string().optional(),
  }),
]);
export type FeedItem = z.infer<typeof FeedItem>;
