// Flightdeck's MCP server for chat turns (PLAN.md §10, §11): plan tools (`get_maps`, `propose_plan`,
// `drop_plan`) and requirements tools (`get_requirements`, `propose_requirements_edit`), offered only to
// Discuss turns. A minimal Streamable-HTTP JSON-RPC endpoint — initialize, tools/list, tools/call.
//
// Who may call it: only the `claude` process of a running Discuss turn. Each such turn gets a fresh
// random token (runner.ts) that this checks, along with the run still going and still in Discuss.
// Requests from a browser page (anything with an Origin header) are refused, the gateway listener
// never routes /mcp, and the body is size-limited and schema-checked. The tool only saves a plan
// version or a requirements proposal: it can't touch files.
import { z } from 'zod';
import { PlanBody, ProposeRequirementsEdit } from '../shared/contracts.ts';
import { db, chats, projects } from './db.ts';
import { eq } from 'drizzle-orm';
import * as feed from './feed.ts';
import { currentMaps, drop, submitProposal } from './plans.ts';
import { requirementsOverview, submitRequirementProposal } from './requirements.ts';
import { activeRunForMcpToken } from './runner.ts';

export const MCP_SERVER = 'flightdeck';
export const PROPOSE_PLAN = 'propose_plan';
export const GET_MAPS = 'get_maps';
export const DROP_PLAN = 'drop_plan';
export const GET_REQUIREMENTS = 'get_requirements';
export const PROPOSE_REQUIREMENTS_EDIT = 'propose_requirements_edit';
// As Claude Code names them; they only read maps and requirements, or save a plan version or a proposal.
export const FLIGHTDECK_TOOLS = new Set([PROPOSE_PLAN, GET_MAPS, DROP_PLAN, GET_REQUIREMENTS, PROPOSE_REQUIREMENTS_EDIT].map(t => `mcp__${MCP_SERVER}__${t}`));
const MAX_BODY = 1 << 20;

function inputSchema() {
  const { $schema: _drop, ...schema } = z.toJSONSchema(PlanBody, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
  return schema;
}

const DESCRIPTION =
  'Propose a change to the project\'s architecture as a change to Flightdeck\'s maps (architecture, ' +
  'data-model, flows). The user sees it drawn over the current map and reviews it there. Describe only ' +
  'what changes: nodes to add (new ids; parent = an existing or new node; files they will live in), ' +
  'nodes to change (existing ids; only the fields that change), nodes or edges to remove, and edges to ' +
  'add, each with a one-line why. Get the current node ids with get_maps. ' +
  'Add build steps in order, and the questions the user still has to decide. Each call saves a new ' +
  'version; the reply says which, or lists what to fix.';

const GET_MAPS_DESCRIPTION =
  'The project\'s current maps (architecture, data-model, flows), compact: each node\'s id, parent, label, ' +
  'kind and files, and each edge. Call this before propose_plan to get the ids to build on.';

// Enough to plan against, without summaries and fields that would crowd the context.
function compactMaps(project: { id: number; path: string; mapsRepo: string | null }) {
  const maps = currentMaps(project);
  return Object.fromEntries(Object.entries(maps).map(([view, m]) => [view, m ? {
    generatedAt: m.generatedAt,
    nodes: m.nodes.map(n => ({ id: n.id, parent: n.parent, label: n.label, kind: n.kind, files: n.files })),
    edges: m.edges.map(e => ({ from: e.from, to: e.to, label: e.label })),
  } : 'no map yet: everything in this view would be new']));
}

const GET_REQUIREMENTS_DESCRIPTION =
  'The project\'s requirements documents (the PRD and feature specs, Markdown under docs/requirements): ' +
  'each one\'s path, title, whether it exists, its state (draft, approved, changed since approval, missing), ' +
  'its approved version and the requirement ids it contains. Read a document\'s text with Read before ' +
  'proposing a change to it.';

const PROPOSE_REQUIREMENTS_DESCRIPTION =
  'Propose a change to a requirements document. You cannot write these files; the user sees your ' +
  'change as a diff in Flightdeck and accepts or rejects it (accepting makes a draft revision, which ' +
  'they approve separately). For an existing document send `edits`: exact old_string/new_string ' +
  'replacements against its current text (read it first; each old_string must be unique). For a new ' +
  'document (e.g. features/<slug>.md) send its whole text as `content`. Requirement ids (BR-001, ' +
  'AC-001) start a heading or list item; once approved they are never renumbered or reused, and an ' +
  'approved rule that no longer applies is marked "(retired)" rather than deleted. Put what the user ' +
  'hasn\'t decided under Open questions. A newer proposal for the same document replaces ' +
  'your open one. The reply says whether it was saved, or what to fix.';

function editInputSchema() {
  const { $schema: _drop, ...schema } = z.toJSONSchema(ProposeRequirementsEdit, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
  return schema;
}

const DROP_DESCRIPTION =
  'Drop this chat\'s plan, when the user asks you to. Build then has no plan to implement. Every version ' +
  'is kept, and a later propose_plan starts a new plan. You cannot approve a plan: only the user does.';

type Rpc = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, unknown> };
const reply = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
const error = (id: Rpc['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export type McpAnswer = { status: number; body?: unknown };

export async function handleMcp(req: Request): Promise<McpAnswer> {
  if (req.headers.get('origin') !== null) return { status: 403, body: { error: 'not for browsers' } };
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const run = token ? activeRunForMcpToken(token) : undefined;
  if (!run) return { status: 401, body: { error: 'no running Discuss turn holds this token' } };
  if (req.method !== 'POST') return { status: 405 }; // no server-initiated stream
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return { status: 413 };
  const text = await req.text();
  if (text.length > MAX_BODY) return { status: 413 };

  let msg: Rpc;
  try { msg = JSON.parse(text); } catch { return { status: 400, body: error(null, -32700, 'parse error') }; }
  if (msg.id === undefined) return { status: 202 }; // a notification (e.g. initialized)

  switch (msg.method) {
    case 'initialize':
      return { status: 200, body: reply(msg.id, {
        protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER, version: '1' },
      }) };
    case 'ping':
      return { status: 200, body: reply(msg.id, {}) };
    case 'tools/list':
      return { status: 200, body: reply(msg.id, { tools: [
        { name: GET_MAPS, description: GET_MAPS_DESCRIPTION, inputSchema: { type: 'object', properties: {} } },
        { name: PROPOSE_PLAN, description: DESCRIPTION, inputSchema: inputSchema() },
        { name: DROP_PLAN, description: DROP_DESCRIPTION, inputSchema: { type: 'object', properties: {} } },
        { name: GET_REQUIREMENTS, description: GET_REQUIREMENTS_DESCRIPTION, inputSchema: { type: 'object', properties: {} } },
        { name: PROPOSE_REQUIREMENTS_EDIT, description: PROPOSE_REQUIREMENTS_DESCRIPTION, inputSchema: editInputSchema() },
      ] }) };
    case 'tools/call': {
      if (msg.params?.name === GET_MAPS) {
        const project = db.select().from(projects).where(eq(projects.id, run.projectId)).get();
        if (!project) return { status: 200, body: error(msg.id, -32602, 'no such project') };
        return { status: 200, body: reply(msg.id, { content: [{ type: 'text', text: JSON.stringify(compactMaps(project)) }] }) };
      }
      if (msg.params?.name === GET_REQUIREMENTS) {
        const project = db.select().from(projects).where(eq(projects.id, run.projectId)).get();
        if (!project) return { status: 200, body: error(msg.id, -32602, 'no such project') };
        return { status: 200, body: reply(msg.id, { content: [{ type: 'text', text: JSON.stringify(requirementsOverview(project)) }] }) };
      }
      if (msg.params?.name === PROPOSE_REQUIREMENTS_EDIT) {
        const chat = db.select().from(chats).where(eq(chats.id, run.chatId)).get();
        const project = db.select().from(projects).where(eq(projects.id, run.projectId)).get();
        if (!chat || !project || chat.projectId !== project.id || run.mode !== 'discuss' || chat.mode !== 'discuss') {
          return { status: 200, body: reply(msg.id, { isError: true, content: [{ type: 'text', text: 'Requirements changes are proposed from a Discuss chat.' }] }) };
        }
        const input = ProposeRequirementsEdit.safeParse(msg.params.arguments ?? {});
        const r = input.success ? submitRequirementProposal(project, chat.id, run.runId, input.data)
          : { ok: false as const, error: input.error.issues.map(i => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ') };
        if (!r.ok) {
          const text = `Nothing was proposed. Fix this and call ${PROPOSE_REQUIREMENTS_EDIT} again: ${r.error}`;
          return { status: 200, body: reply(msg.id, { isError: true, content: [{ type: 'text', text }] }) };
        }
        feed.append(chat.id, {
          kind: 'req-proposal', at: new Date().toISOString(), runId: run.runId, proposalId: r.id, path: input.data!.path, summary: input.data!.summary.trim(),
        });
        return { status: 200, body: reply(msg.id, { content: [{ type: 'text', text:
          `Proposed as #${r.id}${r.created ? ' (a new document)' : ''}. The user reviews the diff in Flightdeck's PRD tab and accepts or rejects it. ` +
          'Say briefly what you proposed; don\'t repeat the text.' }] }) };
      }
      if (msg.params?.name === DROP_PLAN) {
        const chat = db.select().from(chats).where(eq(chats.id, run.chatId)).get();
        if (!chat || chat.mode !== 'discuss' || run.mode !== 'discuss') {
          return { status: 200, body: reply(msg.id, { isError: true, content: [{ type: 'text', text: 'Plans are dropped from a Discuss chat.' }] }) };
        }
        const text = drop(chat.id, 'agent', run.runId) ? 'The plan is dropped. Its versions are kept; a new proposal starts a new plan.' : 'There is no plan in force to drop.';
        return { status: 200, body: reply(msg.id, { content: [{ type: 'text', text }] }) };
      }
      if (msg.params?.name !== PROPOSE_PLAN) return { status: 200, body: error(msg.id, -32602, 'unknown tool') };
      // Checked again at call time: the chat must still be in Discuss and belong to this run's project.
      const chat = db.select().from(chats).where(eq(chats.id, run.chatId)).get();
      const project = db.select().from(projects).where(eq(projects.id, run.projectId)).get();
      if (!chat || !project || chat.projectId !== project.id || run.mode !== 'discuss' || chat.mode !== 'discuss') {
        return { status: 200, body: reply(msg.id, { isError: true, content: [{ type: 'text', text: 'Plans can only be proposed from a Discuss chat.' }] }) };
      }
      const r = submitProposal(chat.id, project, msg.params.arguments ?? {});
      if (!r.ok) {
        const text = `The plan was not saved. Fix these and call ${PROPOSE_PLAN} again:\n- ${r.errors.join('\n- ')}`;
        return { status: 200, body: reply(msg.id, { isError: true, content: [{ type: 'text', text }] }) };
      }
      const { version } = r;
      const body = PlanBody.parse(msg.params.arguments);
      feed.append(chat.id, {
        kind: 'plan', at: new Date().toISOString(), runId: run.runId,
        versionId: version.id, version: version.version, title: body.title, counts: version.counts,
      });
      const c = version.counts;
      return { status: 200, body: reply(msg.id, { content: [{ type: 'text', text:
        `Saved as plan v${version.version} (${c.added} added, ${c.changed} changed, ${c.removed} removed). ` +
        'The user sees it on the map in Flightdeck. Explain it briefly; don\'t repeat the whole plan in text.' }] }) };
    }
    default:
      return { status: 200, body: error(msg.id, -32601, `method not found: ${msg.method}`) };
  }
}
