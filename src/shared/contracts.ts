// The contracts shared by server and UI. Everything that crosses the wire is defined here once,
// so a mismatch between the two sides fails the type check instead of failing silently.
import { z } from 'zod';
import { STACK_IDS } from './stacks.ts';

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
  realPath: z.string(), // path with symlinks resolved — what Claude Code reports in tool calls
  discussModel: z.string(), // the project's default for Discuss turns
  buildModel: z.string(), // …and for Build turns
  mapsRepo: z.string().nullable(), // multi-repo folder: the repo whose .flightdeck/ keeps the maps (null = the folder)
  repos: z.array(z.string()), // multi-repo folder: its repositories; empty for a single repo
  createdAt: z.string(),
});
export type Project = z.infer<typeof Project>;

export const NewProject = z.object({ name: z.string().min(1), path: z.string().min(1) });
// start: 'scaffold' opens a Build chat that generates the stack now; 'requirements' opens a Discuss
// chat to define what to build first (PLAN.md §11) — the stack, if given, is only the intention.
export const CreateProject = z.object({
  name: z.string().trim().min(1),
  path: z.string().min(1),
  start: z.enum(['scaffold', 'requirements']).default('scaffold'),
  stack: z.enum(STACK_IDS).optional(),
  description: z.string().optional(),
}).refine(b => b.start === 'requirements' || b.stack !== undefined, { message: 'choose a stack to scaffold' });
export const ProjectSettings = z.object({
  discussModel: z.string().min(1),
  buildModel: z.string().min(1),
  mapsRepo: z.string().nullable().optional(),
});

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

// A map node attached to a message as context (Phase 1c). `view` is a MapViewId, checked server-side.
export const NodeContext = z.object({ view: z.string(), nodeId: z.string() });
// A requirement (BR-001) or a section (§Scope) of a requirements document (PLAN.md §11), attached the
// same way: the server reads its text from the file.
export const RequirementContext = z.object({ doc: z.string(), ref: z.string().min(1).max(200) });
export const SendMessage = z.object({ text: z.string().min(1), context: z.array(z.union([NodeContext, RequirementContext])).max(20).optional() });
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

// How a planned item turned out when checked against the code (PLAN.md §10).
export const CheckResult = z.enum(['verified', 'missing', 'unexpected', 'review']);
export type CheckResult = z.infer<typeof CheckResult>;

const base = { at: z.string(), runId: z.number() };

export const FeedItem = z.discriminatedUnion('kind', [
  // mode/model: what this turn ran with, so the history shows it.
  z.object({
    kind: z.literal('user'), ...base, text: z.string(), mode: Mode.optional(), model: z.string().optional(),
    // Map nodes carry view/nodeId; requirements doc/ref (and the revision they were sent at).
    context: z.array(z.object({
      view: z.string().optional(), nodeId: z.string().optional(), doc: z.string().optional(), ref: z.string().optional(),
      revision: z.string().optional(), auto: z.boolean().optional(), label: z.string(),
    })).optional(),
  }),
  z.object({ kind: z.literal('claude'), ...base, event: ClaudeEvent }),
  z.object({
    kind: z.literal('run'),
    ...base,
    status: z.enum(['started', 'finished', 'failed', 'stopped']),
    detail: z.string().optional(),
  }),
  // The agent proposed a plan version (Discuss), through Flightdeck's propose_plan tool.
  z.object({
    kind: z.literal('plan'), ...base, versionId: z.number(), version: z.number(), title: z.string(),
    counts: z.object({ added: z.number(), changed: z.number(), removed: z.number() }),
  }),
  // The agent proposed an edit to a requirements document (Discuss), to review in the PRD tab.
  z.object({ kind: z.literal('req-proposal'), ...base, proposalId: z.number(), path: z.string(), summary: z.string() }),
  // The chat's plan was dropped: by you (the Drop button) or by the agent when you asked in the chat.
  z.object({ kind: z.literal('plan-dropped'), ...base, by: z.enum(['user', 'agent']) }),
  // A check of what was built against the approved plan finished.
  z.object({
    kind: z.literal('check'), ...base, checkId: z.number(), version: z.number(), versionId: z.number().optional(),
    counts: z.record(CheckResult, z.number()), failed: z.string().optional(),
  }),
  z.object({
    kind: z.literal('approval'),
    ...base,
    approvalId: z.number(),
    toolName: z.string(),
    toolInput: z.record(z.string(), z.unknown()),
    toolUseId: z.string().optional(),
    state: z.enum(['pending', 'allowed', 'denied']),
    decidedBy: z.enum(['user', 'rule', 'timeout', 'lock', 'mode', 'requirements']).optional(),
    rule: z.string().optional(),
    reason: z.string().optional(),
    suggestedPattern: z.string().optional(),
    note: z.string().optional(), // why this asks when a rule might suggest otherwise (e.g. Discuss mode)
  }),
]);
export type FeedItem = z.infer<typeof FeedItem>;

// ---------------------------------------------------------------------------------------------
// Maps (Phase 1b): diagrams generated from the code. Flat node list with `parent` links — the
// hierarchy is what drill-down walks. Stored in the repo at `.flightdeck/<view>.json`.
// ---------------------------------------------------------------------------------------------

export const MapViewId = z.enum(['architecture', 'data-model', 'flows']);
export type MapViewId = z.infer<typeof MapViewId>;
export const MAP_VIEWS: { id: MapViewId; label: string }[] = [
  { id: 'architecture', label: 'Architecture' },
  { id: 'data-model', label: 'Data model' },
  { id: 'flows', label: 'Flows' },
];

export const MapField = z.object({ name: z.string(), type: z.string(), note: z.string() });

export const MapNode = z.object({
  id: z.string().min(1),
  parent: z.string().nullable(),
  label: z.string().min(1),
  kind: z.string(),
  summary: z.string(),
  files: z.array(z.string()), // repo-relative files, or directories ending in '/'
  fields: z.array(MapField), // data-model columns; empty elsewhere
});
export type MapNode = z.infer<typeof MapNode>;

export const MapEdge = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string(),
  // Where the code makes this relationship ("src/api/client.ts" or "src/api/client.ts:42"). Kept
  // only when the file exists; an edge without it is the model's inference, and is shown as such.
  evidence: z.string().optional(),
});
export type MapEdge = z.infer<typeof MapEdge>;

// What the agent returns (also the --json-schema it is held to).
export const GeneratedMap = z.object({ nodes: z.array(MapNode), edges: z.array(MapEdge) });

// What Flightdeck stores.
export const StoredMap = GeneratedMap.extend({
  version: z.literal(1),
  view: MapViewId,
  generatedAt: z.string(),
  commit: z.string().nullable(), // HEAD when generated — the base for change detection
  commits: z.record(z.string(), z.string()).optional(), // multi-repo folder: each repository's HEAD instead
  model: z.string(),
  warnings: z.array(z.string()),
});
export type StoredMap = z.infer<typeof StoredMap>;

export const MapJob = z.object({
  view: MapViewId,
  status: z.enum(['running', 'done', 'failed', 'stopped']),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  steps: z.number(), // tool calls so far
  activity: z.string(), // the latest one, for a progress line
  error: z.string().nullable(),
});
export type MapJob = z.infer<typeof MapJob>;

export const MapResponse = z.object({
  map: StoredMap.nullable(),
  staleNodeIds: z.array(z.string()), // nodes whose files changed since `commit`
  changedFiles: z.array(z.string()),
  baseMissing: z.boolean().optional(), // the commit the map was made from is gone (rebase/reset): change is unknown
  job: MapJob.nullable(),
});
export type MapResponse = z.infer<typeof MapResponse>;

// ---------------------------------------------------------------------------------------------
// Plans (PLAN.md §10): a proposed change to the maps, made in a Discuss chat. A separate layer —
// nothing here is ever written into a map file. Versions are immutable once saved.
// ---------------------------------------------------------------------------------------------

const Why = z.string().min(1).max(500).describe('one line: why this change');
const Path = z.string().min(1).max(300);

export const PlanAddNode = MapNode.extend({
  files: z.array(Path).describe('files it will live in, repo-relative; they may not exist yet'),
  why: Why,
});
export const PlanChangeNode = z.object({
  id: z.string().min(1).describe('an existing node'),
  label: z.string().min(1).optional(), kind: z.string().optional(), summary: z.string().optional(),
  files: z.array(Path).optional(), fields: z.array(MapField).optional(),
  why: Why,
});
export const PlanRemoveNode = z.object({ id: z.string().min(1), why: Why });
export const PlanAddEdge = z.object({ from: z.string().min(1), to: z.string().min(1), label: z.string(), why: Why });
export const PlanRemoveEdge = z.object({
  from: z.string().min(1), to: z.string().min(1),
  label: z.string().optional().describe('only needed when several edges join the same two nodes'),
  why: Why,
});

export const PlanViewChange = z.object({
  addNodes: z.array(PlanAddNode).max(200).default([]),
  changeNodes: z.array(PlanChangeNode).max(200).default([]),
  removeNodes: z.array(PlanRemoveNode).max(200).default([]), // removing a node removes everything inside it
  addEdges: z.array(PlanAddEdge).max(400).default([]),
  removeEdges: z.array(PlanRemoveEdge).max(400).default([]),
});
export type PlanViewChange = z.infer<typeof PlanViewChange>;

// What the agent submits (also the `propose_plan` tool's input schema).
export const PlanBody = z.object({
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(4000),
  changes: z.object({
    architecture: PlanViewChange.optional(),
    'data-model': PlanViewChange.optional(),
    flows: PlanViewChange.optional(),
  }),
  steps: z.array(z.object({
    text: z.string().min(1).max(1000),
    nodes: z.array(z.string()).default([]).describe('"view:id" of the nodes this step builds or changes'),
  })).max(50).default([]),
  questions: z.array(z.string().min(1).max(1000)).max(20).default([]).describe('what is still open for the user to decide'),
});
export type PlanBody = z.infer<typeof PlanBody>;

// The code and maps a version was made against: each repository's HEAD and its working-tree changes
// at that moment (path → content hash; "absent" for a deleted file), and each map it refers to.
export const PlanBaseline = z.object({
  repos: z.record(z.string(), z.object({ head: z.string().nullable(), dirty: z.record(z.string(), z.string()) })),
  maps: z.record(z.string(), z.object({ generatedAt: z.string(), commit: z.string().nullable() }).nullable()),
  takenAt: z.string(),
});
export type PlanBaseline = z.infer<typeof PlanBaseline>;

// fresh: nothing changed · elsewhere: code changed, but not where the plan works · stale: code the plan
// covers changed · map-regenerated: a map it refers to was regenerated. The last two need revalidation.
export const PlanFreshness = z.object({
  state: z.enum(['fresh', 'elsewhere', 'stale', 'map-regenerated']),
  touched: z.array(z.string()), // changed files the plan covers
  changed: z.number(), // all changed files
  maps: z.array(MapViewId), // views whose map was regenerated
  baseMissing: z.boolean(), // a commit the plan was made against is gone (rebase/reset)
});
export type PlanFreshness = z.infer<typeof PlanFreshness>;

// Checking what was built against an approved version (PLAN.md §10). A map id only aligns plan and
// code; a result rests on git changes, files and citations in code.
export const CheckItem = z.object({
  view: MapViewId.nullable(), // null: a changed file no planned part accounts for
  kind: z.enum(['node', 'edge', 'file']),
  change: z.enum(['add', 'change', 'remove', 'none']),
  id: z.string(), // node id, "from→to", or a file path
  label: z.string(),
  result: CheckResult,
  evidence: z.array(z.string()), // what the result rests on, one plain line each
});
export type CheckItem = z.infer<typeof CheckItem>;
export const PlanCheck = z.object({
  id: z.number(), versionId: z.number(), version: z.number(), createdAt: z.string(),
  status: z.enum(['running', 'done', 'failed']), progress: z.string(), error: z.string().nullable(),
  items: z.array(CheckItem),
  tests: z.array(z.object({ command: z.string(), ok: z.boolean(), at: z.string() })), // test runs seen in Build turns
  counts: z.record(CheckResult, z.number()),
});
export type PlanCheck = z.infer<typeof PlanCheck>;

export const PlanVersionInfo = z.object({
  id: z.number(), version: z.number(), source: z.enum(['agent', 'revalidated']),
  createdAt: z.string(), approvedAt: z.string().nullable(),
  counts: z.object({ added: z.number(), changed: z.number(), removed: z.number() }),
});
export type PlanVersionInfo = z.infer<typeof PlanVersionInfo>;

export const PlanResponse = z.object({
  plan: z.object({
    id: z.number(), status: z.enum(['draft', 'approved', 'done', 'dropped']),
    approvedVersionId: z.number().nullable(),
  }).nullable(),
  versions: z.array(PlanVersionInfo),
  // The version asked for (default: the latest), with its content and how current it still is.
  version: PlanVersionInfo.extend({ body: PlanBody, baseline: PlanBaseline, warnings: z.array(z.string()), freshness: PlanFreshness }).nullable(),
  check: PlanCheck.nullable(), // the latest check of the approved version
});
export type PlanResponse = z.infer<typeof PlanResponse>;

export const FileResponse = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), path: z.string(), content: z.string(), truncated: z.boolean() }),
  z.object({ kind: z.literal('dir'), path: z.string(), entries: z.array(z.string()) }),
  z.object({ kind: z.literal('binary'), path: z.string(), size: z.number() }),
]);
export type FileResponse = z.infer<typeof FileResponse>;

// A tree of processes running in a project's folder (a dev server, a watcher…), named by its root.
export const ProcessGroup = z.object({
  pid: z.number(), command: z.string(), secs: z.number(), // how long the root has been running
  ports: z.array(z.number()), // TCP ports anything in the tree listens on
  pids: z.array(z.number()),
});
export type ProcessGroup = z.infer<typeof ProcessGroup>;

// One folder in the "Add existing" browser: its subfolders, and which of them can be added as projects.
export const BrowseResponse = z.object({
  path: z.string(),
  parent: z.string().nullable(), // null at the browse root
  addable: z.boolean(), // a git repository, or a folder whose direct subfolders are repositories
  dirs: z.array(z.object({ name: z.string(), path: z.string(), addable: z.boolean() })),
});
export type BrowseResponse = z.infer<typeof BrowseResponse>;

// ---------------------------------------------------------------------------------------------
// Requirements (PLAN.md §11): the PRD and feature specs, Markdown files under docs/requirements in the
// repository. Approval is kept in Flightdeck's database (insert-only), never in the file.
// ---------------------------------------------------------------------------------------------

// draft: never approved · approved: the file is exactly the latest approved version ·
// changed: approved before, the file differs since (a new draft revision) · missing: approved, file gone.
export const RequirementState = z.enum(['draft', 'approved', 'changed', 'missing']);
export type RequirementState = z.infer<typeof RequirementState>;

export const RequirementDocSummary = z.object({
  path: z.string(), // relative to docs/requirements
  title: z.string().nullable(),
  hash: z.string().nullable(), // null: no file
  state: RequirementState,
  approved: z.object({ version: z.number(), hash: z.string(), approvedAt: z.string() }).nullable(), // the latest approval
  git: z.enum(['committed', 'modified', 'untracked', 'none']), // none: not inside a git repository
  ids: z.array(z.string()),
});
export type RequirementDocSummary = z.infer<typeof RequirementDocSummary>;

export const RequirementsResponse = z.object({
  dir: z.string(), // where they live, relative to the project folder
  docs: z.array(RequirementDocSummary),
});
export type RequirementsResponse = z.infer<typeof RequirementsResponse>;

export const RequirementDoc = z.object({
  summary: RequirementDocSummary,
  content: z.string().nullable(), // the file now (null: no file)
  versions: z.array(z.object({ version: z.number(), hash: z.string(), approvedAt: z.string() })), // newest first
  viewing: z.object({ version: z.number(), content: z.string() }).nullable(), // an approved version, when one was asked for
});
export type RequirementDoc = z.infer<typeof RequirementDoc>;

// Save the file. baseHash: the content's hash when editing began (null: creating it). A mismatch means
// the file changed meanwhile (an editor, git) and the save is refused with 409 and the current text.
export const SaveRequirementDoc = z.object({ path: z.string(), content: z.string().max(512 * 1024), baseHash: z.string().nullable() });
// Approve exactly what was reviewed: the hash shown must still be the file's.
export const ApproveRequirementDoc = z.object({ path: z.string(), hash: z.string() });

// An edit to a requirements document proposed by the agent in a Discuss chat: reviewed as a diff in
// the PRD tab, written only when accepted (as a draft revision — approving is separate).
export const RequirementProposalStatus = z.enum(['open', 'accepted', 'rejected', 'superseded']);
export const RequirementProposal = z.object({
  id: z.number(),
  path: z.string(),
  chatId: z.number(),
  chatTitle: z.string(),
  summary: z.string(),
  status: RequirementProposalStatus,
  baseHash: z.string().nullable(), // the file it was made against (null: a new document)
  current: z.string().nullable(), // the file now, to diff against
  currentHash: z.string().nullable(),
  content: z.string(), // the document as proposed
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
});
export type RequirementProposal = z.infer<typeof RequirementProposal>;

// What the agent sends: Edit-style replacements against the current file, or a whole document (to
// create one). The file is never written by this; Accept does that.
export const ProposeRequirementsEdit = z.object({
  path: z.string().describe('The document, relative to the requirements folder: "PRD.md" or "features/<slug>.md" (slug: lower-case letters, digits, dashes)'),
  summary: z.string().min(1).max(500).describe('One or two sentences: what changes and why. The user reads this first.'),
  edits: z.array(z.object({
    old_string: z.string().describe('Exact text from the current document, unique in it'),
    new_string: z.string(),
  })).max(50).optional().describe('Replacements applied in order to the current document. Use this for changes to an existing document.'),
  content: z.string().max(512 * 1024).optional().describe('The whole document. Use this only to create a document that does not exist yet.'),
});
export type ProposeRequirementsEdit = z.infer<typeof ProposeRequirementsEdit>;
