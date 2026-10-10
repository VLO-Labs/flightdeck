// Flightdeck server: UI + API + live chat streams (SSE) + the Claude Code hook. Loopback only.
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import {
  ChatSettings, Decision, HookPayload, MapViewId, NewProject, NewRule, ProjectSettings, SendMessage,
  type Chat, type MapResponse,
} from '../shared/contracts.ts';
import { config } from './config.ts';
import { db, chats, projects, rules } from './db.ts';
import * as feed from './feed.ts';
import { decide, hookResponse, lockHolder, resolveApproval } from './hook.ts';
import { effectiveModel, isRunning, startTurn, stopTurn } from './runner.ts';
import { TEMPLATE_RULES } from './rules.ts';
import { changedSince, generatorDecision, jobFor, jobForSession, readMap, staleNodeIds, startGeneration, stopGeneration } from './maps.ts';
import { viewFile } from './files.ts';

const app = new Hono();
const now = () => new Date().toISOString();

// --- Claude Code's PreToolUse hook --------------------------------------------------------------
app.post('/hook', async c => {
  const parsed = HookPayload.safeParse(await c.req.json());
  if (!parsed.success) return c.json(hookResponse({ decision: 'deny', reason: 'Flightdeck could not read the hook payload' }));
  return c.json(hookResponse(await decide(parsed.data)));
});

// The map generator's hook: read-only tools only, decided without cards.
app.post('/hook/map', async c => {
  const parsed = HookPayload.safeParse(await c.req.json());
  const deny = (reason: string) => c.json(hookResponse({ decision: 'deny', reason }));
  if (!parsed.success) return deny('Flightdeck could not read the hook payload');
  const job = jobForSession(parsed.data.session_id);
  if (!job) return deny('Flightdeck has no running map generation for this session');
  const project = db.select().from(projects).where(eq(projects.id, job.projectId)).get()!;
  const v = generatorDecision(parsed.data.tool_name, parsed.data.tool_input, project.path);
  return v.bucket === 'allow'
    ? c.json(hookResponse({ decision: 'allow', reason: 'read-only mapping' }))
    : deny('Mapping is read-only: only reading, searching and git inspection are allowed.');
});

// --- Projects -----------------------------------------------------------------------------------
app.get('/api/projects', c => c.json(db.select().from(projects).all()));

app.post('/api/projects', async c => {
  const body = NewProject.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: 'name and path are required' }, 400);
  const { path } = body.data;
  if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isDirectory())
    return c.json({ error: `${path} doesn't exist on the box. Flightdeck adds existing git repositories.` }, 400);
  if (!existsSync(`${path}/.git`)) return c.json({ error: `${path} is not a git repository` }, 400);
  if (db.select().from(projects).where(eq(projects.path, path)).get())
    return c.json({ error: 'that folder is already a project' }, 400);

  const project = db.insert(projects)
    .values({ name: body.data.name || basename(path), path, discussModel: config.defaultModel, buildModel: config.defaultModel, createdAt: now() })
    .returning().get();
  for (const r of TEMPLATE_RULES) db.insert(rules).values({ ...r, projectId: project.id }).run();
  return c.json(project);
});

app.post('/api/projects/:id/settings', async c => {
  const body = ProjectSettings.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: 'both models are required' }, 400);
  const row = db.update(projects).set(body.data).where(eq(projects.id, Number(c.req.param('id')))).returning().get();
  return row ? c.json(row) : c.json({ error: 'no such project' }, 404);
});

// --- Maps ---------------------------------------------------------------------------------------
const projectById = (id: string) => db.select().from(projects).where(eq(projects.id, Number(id))).get();

app.get('/api/projects/:id/maps/:view', c => {
  const project = projectById(c.req.param('id'));
  const view = MapViewId.safeParse(c.req.param('view'));
  if (!project || !view.success) return c.json({ error: 'not found' }, 404);
  const map = readMap(project.path, view.data);
  let staleIds: string[] = [];
  let changed: string[] = [];
  if (map) {
    const since = changedSince(project.path, map.commit);
    if (since === null) {
      staleIds = map.nodes.map(n => n.id); // the map's commit is gone (rebased/reset): treat all as stale
      changed = ['(the commit this map was made from no longer exists)'];
    } else {
      changed = since;
      staleIds = staleNodeIds(map.nodes, since);
    }
  }
  const job = jobFor(project.id);
  const body: MapResponse = { map, staleNodeIds: staleIds, changedFiles: changed, job: job?.view === view.data ? job : job?.status === 'running' ? job : null };
  return c.json(body);
});

app.post('/api/projects/:id/maps/:view/generate', c => {
  const project = projectById(c.req.param('id'));
  const view = MapViewId.safeParse(c.req.param('view'));
  if (!project || !view.success) return c.json({ error: 'not found' }, 404);
  const r = startGeneration(project, view.data);
  return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, 409);
});

app.post('/api/projects/:id/maps/stop', c => c.json({ ok: stopGeneration(Number(c.req.param('id'))) }));

app.get('/api/projects/:id/file', c => {
  const project = projectById(c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  const r = viewFile(project.path, c.req.query('path') ?? '');
  return 'error' in r ? c.json(r, 404) : c.json(r);
});

// --- Rules ----------------------------------------------------------------------------------------
app.get('/api/projects/:id/rules', c =>
  c.json(db.select().from(rules).where(eq(rules.projectId, Number(c.req.param('id')))).all()));

app.post('/api/projects/:id/rules', async c => {
  const body = NewRule.safeParse(await c.req.json());
  if (!body.success || !body.data.pattern.trim()) return c.json({ error: 'bucket and pattern are required' }, 400);
  const row = db.insert(rules)
    .values({ projectId: Number(c.req.param('id')), bucket: body.data.bucket, pattern: body.data.pattern.trim(), reason: body.data.reason?.trim() || null })
    .returning().get();
  return c.json(row);
});

app.delete('/api/projects/:id/rules/:ruleId', c => {
  db.delete(rules).where(and(eq(rules.id, Number(c.req.param('ruleId'))), eq(rules.projectId, Number(c.req.param('id'))))).run();
  return c.json({ ok: true });
});

// --- Chats ----------------------------------------------------------------------------------------
function toChat(row: typeof chats.$inferSelect): Chat {
  const project = db.select().from(projects).where(eq(projects.id, row.projectId)).get()!;
  return {
    id: row.id, projectId: row.projectId, title: row.title, sessionId: row.sessionId, mode: row.mode,
    discussModel: effectiveModel(row, project, 'discuss'), buildModel: effectiveModel(row, project, 'build'),
    discussModelOverridden: row.discussModel !== null, buildModelOverridden: row.buildModel !== null,
    createdAt: row.createdAt, running: isRunning(row.id), holdsEditLock: lockHolder(row.projectId) === row.id,
  };
}

app.get('/api/projects/:id/chats', c =>
  c.json(db.select().from(chats).where(eq(chats.projectId, Number(c.req.param('id')))).orderBy(desc(chats.id)).all().map(toChat)));

app.post('/api/projects/:id/chats', c => {
  const projectId = Number(c.req.param('id'));
  if (!db.select().from(projects).where(eq(projects.id, projectId)).get()) return c.json({ error: 'no such project' }, 404);
  const row = db.insert(chats)
    .values({ projectId, title: 'New chat', sessionId: randomUUID(), mode: 'discuss', createdAt: now() })
    .returning().get();
  return c.json(toChat(row));
});

app.post('/api/chats/:id/messages', async c => {
  const id = Number(c.req.param('id'));
  const body = SendMessage.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: 'empty message' }, 400);
  const chat = db.select().from(chats).where(eq(chats.id, id)).get();
  if (chat && chat.title === 'New chat') {
    const title = body.data.text.replace(/\s+/g, ' ').trim().slice(0, 60);
    db.update(chats).set({ title }).where(eq(chats.id, id)).run();
  }
  const r = startTurn(id, body.data.text);
  return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, 409);
});

app.post('/api/chats/:id/settings', async c => {
  const id = Number(c.req.param('id'));
  const body = ChatSettings.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: 'bad settings' }, 400);
  // The mode and models are fixed for the duration of a turn.
  if (isRunning(id)) return c.json({ error: 'wait for the current turn to finish' }, 409);
  const row = db.update(chats).set(body.data).where(eq(chats.id, id)).returning().get();
  return row ? c.json(toChat(row)) : c.json({ error: 'no such chat' }, 404);
});

app.post('/api/chats/:id/stop', c => c.json({ ok: stopTurn(Number(c.req.param('id'))) }));

app.post('/api/approvals/:id', async c => {
  const body = Decision.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: 'bad decision' }, 400);
  return resolveApproval(Number(c.req.param('id')), body.data)
    ? c.json({ ok: true })
    : c.json({ error: 'that approval is no longer open' }, 409);
});

// The chat feed: full replay first, then live items. One stream per open chat.
app.get('/api/chats/:id/feed', c => {
  const chatId = Number(c.req.param('id'));
  return streamSSE(c, async stream => {
    const queue: string[] = [];
    let wake: (() => void) | undefined;
    const unsubscribe = feed.subscribe(chatId, item => {
      queue.push(JSON.stringify(item));
      wake?.();
    });
    stream.onAbort(() => {
      unsubscribe();
      wake?.();
    });
    for (const item of feed.replay(chatId)) await stream.writeSSE({ data: JSON.stringify(item) });
    await stream.writeSSE({ event: 'replayed', data: '' });
    while (!stream.aborted) {
      if (queue.length === 0) {
        await Promise.race([new Promise<void>(r => (wake = r)), stream.sleep(15000)]);
        if (queue.length === 0 && !stream.aborted) await stream.writeSSE({ event: 'ping', data: '' });
        continue;
      }
      await stream.writeSSE({ data: queue.shift()! });
    }
  });
});

// --- The web app ----------------------------------------------------------------------------------
app.use('/*', serveStatic({ root: './dist' }));
app.get('/*', serveStatic({ path: './dist/index.html' }));

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, info =>
  console.log(`flightdeck on http://${config.host}:${info.port} · data ${config.dataDir} · default model ${config.defaultModel}`));
