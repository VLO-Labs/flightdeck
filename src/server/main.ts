// Flightdeck server: UI + API + live chat streams (SSE) + the Claude Code hook. Loopback only.
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { execFileSync } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import {
  ChatSettings, CreateProject, Decision, HookPayload, MapViewId, NewProject, NewRule, ProjectSettings, SendMessage,
  type BrowseResponse, type Chat, type MapResponse, type Project,
} from '../shared/contracts.ts';
import { config } from './config.ts';
import { db, chats, projects, rules } from './db.ts';
import * as feed from './feed.ts';
import { decide, hookResponse, lockHolder, resolveApproval } from './hook.ts';
import { effectiveModel, isRunning, startTurn, stopTurn } from './runner.ts';
import { TEMPLATE_RULES } from './rules.ts';
import { changedSince, generatorDecision, jobFor, jobForSession, mapsDir, moveMaps, readMap, repoDirs, staleNodeIds, startGeneration, stopGeneration } from './maps.ts';
import { viewFile } from './files.ts';
import { refuseLocal } from './guard.ts';
import { STACKS, scaffoldPrompt } from '../shared/stacks.ts';

const app = new Hono();
const now = () => new Date().toISOString();

app.get('/health', c => c.json({ ok: true }));

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
function toProject(row: typeof projects.$inferSelect): Project {
  let realPath = row.path;
  try { realPath = realpathSync(row.path); } catch { /* folder gone; keep the configured path */ }
  const repos = repoDirs(row.path).filter(r => r !== '');
  return { ...row, realPath, repos };
}

app.get('/api/projects', c => c.json(db.select().from(projects).all().map(toProject)));

app.post('/api/projects', async c => {
  const body = NewProject.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: 'name and path are required' }, 400);
  const { path } = body.data;
  if (isAbsolute(path) && !underBrowseRoot(path)) return c.json({ error: outsideRoot() }, 400);
  if (isAbsolute(path) && existsSync(path) && existsSync(config.browseRoot) && realpathSync(path) === realpathSync(config.browseRoot))
    return c.json({ error: `${config.browseRoot} itself can't be a project; pick a folder inside it` }, 400);
  if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isDirectory())
    return c.json({ error: `${path} doesn't exist on the box. Use "New project" to create one.` }, 400);
  if (repoDirs(path).length === 0)
    return c.json({ error: `${path} is not a git repository, and none of its subfolders is one` }, 400);
  // Compare resolved paths: ~/dev is a symlink, so one repo can be typed two ways.
  const real = realpathSync(path);
  if (db.select().from(projects).all().some(p => toProject(p).realPath === real))
    return c.json({ error: 'that folder is already a project' }, 400);

  return c.json(toProject(insertProject(body.data.name || basename(path), path)));
});

// Projects live under config.browseRoot (the box's ~/dev). True when `path` is there once symlinks
// are resolved; a folder that doesn't exist yet is judged by its nearest existing parent.
const isInside = (realRoot: string, real: string) => real === realRoot || real.startsWith(realRoot + '/');
function underBrowseRoot(path: string): boolean {
  let realRoot: string;
  try { realRoot = realpathSync(config.browseRoot); } catch { return false; }
  let existing = resolve(path);
  let rest = '';
  while (!existsSync(existing)) {
    rest = join(basename(existing), rest);
    existing = dirname(existing);
  }
  return isInside(realRoot, join(realpathSync(existing), rest).replace(/\/$/, ''));
}
const outsideRoot = () => `projects must be under ${config.browseRoot}`;

// Folder browser for "Add existing", confined to config.browseRoot. Paths are checked after
// resolving symlinks (~/dev itself is one), and shown in browse-root terms.
app.get('/api/browse', c => {
  let realRoot: string;
  try { realRoot = realpathSync(config.browseRoot); } catch { return c.json({ error: `${config.browseRoot} doesn't exist` }, 500); }
  const inside = (real: string) => isInside(realRoot, real);
  const asked = c.req.query('path') || config.browseRoot;
  let real: string;
  try { real = realpathSync(asked); } catch { return c.json({ error: `${asked} doesn't exist` }, 404); }
  if (!inside(real) || !statSync(real).isDirectory()) return c.json({ error: `only folders under ${config.browseRoot} can be browsed` }, 403);

  const shown = (r: string) => join(config.browseRoot, relative(realRoot, r));
  const dirs: BrowseResponse['dirs'] = [];
  for (const e of readdirSync(real, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'vendor') continue;
    let r: string;
    try { r = realpathSync(join(real, e.name)); } catch { continue; }
    if (!inside(r) || !statSync(r).isDirectory()) continue;
    dirs.push({ name: e.name, path: shown(r), addable: repoDirs(r).length > 0 });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  return c.json({
    path: shown(real),
    parent: real === realRoot ? null : shown(join(real, '..')),
    addable: real !== realRoot && repoDirs(real).length > 0, // ~/dev itself is never one project
    dirs,
  } satisfies BrowseResponse);
});

// A brand-new project: make the folder, `git init` it, and open a Build chat that scaffolds the
// chosen stack. The scaffolding is an ordinary turn, so its commands go through the approval rules.
app.post('/api/projects/new', async c => {
  const body = CreateProject.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: 'name, folder and stack are required' }, 400);
  const { name, path, stack, description } = body.data;
  if (!isAbsolute(path)) return c.json({ error: 'the folder must be an absolute path' }, 400);
  if (!underBrowseRoot(path)) return c.json({ error: outsideRoot() }, 400);
  if (existsSync(path)) return c.json({ error: `${path} already exists. Use "Add project" for an existing repository.` }, 400);
  const err = initRepo(path);
  if (err) return c.json({ error: err }, 400);

  const project = insertProject(name, path);
  const chat = db.insert(chats)
    .values({ projectId: project.id, title: `Scaffold: ${STACKS.find(s => s.id === stack)!.label}`, sessionId: randomUUID(), mode: 'build', createdAt: now() })
    .returning().get();
  const r = startTurn(chat.id, scaffoldPrompt(stack, name, description));
  return c.json({ project: toProject(project), chatId: chat.id, error: r.ok ? undefined : r.error });
});

function initRepo(path: string): string | null {
  try {
    mkdirSync(path, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: path, encoding: 'utf8' });
    return null;
  } catch (e) {
    return `couldn't create ${path}: ${(e as Error).message}`;
  }
}

function insertProject(name: string, path: string) {
  const project = db.insert(projects)
    .values({ name, path, discussModel: config.defaultModel, buildModel: config.defaultModel, createdAt: now() })
    .returning().get();
  for (const r of TEMPLATE_RULES) db.insert(rules).values({ ...r, projectId: project.id }).run();
  return project;
}

app.post('/api/projects/:id/settings', async c => {
  const body = ProjectSettings.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: 'both models are required' }, 400);
  const project = projectById(c.req.param('id'));
  if (!project) return c.json({ error: 'no such project' }, 404);
  const { mapsRepo, ...models } = body.data;
  if (mapsRepo !== undefined && mapsRepo !== project.mapsRepo) {
    if (mapsRepo !== null && !repoDirs(project.path).filter(r => r !== '').includes(mapsRepo))
      return c.json({ error: `${mapsRepo} is not one of this project's repositories` }, 400);
    if (jobFor(project.id)?.status === 'running') return c.json({ error: 'wait for the map being generated to finish' }, 409);
    moveMaps(mapsDir(project), mapsDir({ path: project.path, mapsRepo }));
  }
  const row = db.update(projects).set({ ...models, ...(mapsRepo !== undefined ? { mapsRepo } : {}) })
    .where(eq(projects.id, project.id)).returning().get();
  return c.json(toProject(row!));
});

// --- Maps ---------------------------------------------------------------------------------------
const projectById = (id: string) => db.select().from(projects).where(eq(projects.id, Number(id))).get();

app.get('/api/projects/:id/maps/:view', c => {
  const project = projectById(c.req.param('id'));
  const view = MapViewId.safeParse(c.req.param('view'));
  if (!project || !view.success) return c.json({ error: 'not found' }, 404);
  const map = readMap(mapsDir(project), view.data);
  let staleIds: string[] = [];
  let changed: string[] = [];
  let baseMissing = false;
  if (map) {
    const since = changedSince(project.path, map);
    if (since === null) {
      staleIds = map.nodes.map(n => n.id); // the map's commit is gone (rebased/reset): any box may be outdated
      baseMissing = true;
    } else {
      changed = since;
      staleIds = staleNodeIds(map.nodes, since);
    }
  }
  const job = jobFor(project.id);
  const body: MapResponse = { map, staleNodeIds: staleIds, changedFiles: changed, baseMissing, job: job?.view === view.data ? job : job?.status === 'running' ? job : null };
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
  // Resolve attached map nodes from the map files on disk.
  const context = [];
  const project = chat && db.select().from(projects).where(eq(projects.id, chat.projectId)).get();
  for (const ref of body.data.context ?? []) {
    const view = MapViewId.safeParse(ref.view);
    const node = project && view.success ? readMap(mapsDir(project), view.data)?.nodes.find(n => n.id === ref.nodeId) : undefined;
    if (!node || !view.success) return c.json({ error: `map node ${ref.view}/${ref.nodeId} not found — refresh the map` }, 400);
    context.push({ view: view.data, nodeId: node.id, label: node.label, kind: node.kind, summary: node.summary, files: node.files });
  }
  const r = startTurn(id, body.data.text, context);
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
  c.header('X-Accel-Buffering', 'no'); // nginx (the SSO gateway) must not buffer a live stream
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

// No login on loopback: this check is what keeps other web pages from driving Flightdeck.
const guarded = (req: Request) => {
  const why = refuseLocal(req);
  return why ? new Response(why, { status: 403 }) : app.fetch(req);
};
serve({ hostname: config.host, port: config.port, fetch: guarded }, info =>
  console.log(`flightdeck on http://${config.host}:${info.port} · data ${config.dataDir} · default model ${config.defaultModel}`));
// A second loopback port that only exists as the target of the Mac's port-80 forwarding
// (scripts/mac/port80.sh). macOS's pf breaks direct connections to a port it forwards to, so the
// forwarding gets its own port and the main one (also the one the hook uses) stays untouched.
if (config.forwardPort) {
  serve({ hostname: config.host, port: config.forwardPort, fetch: guarded }, info =>
    console.log(`flightdeck forwarding target on http://${config.host}:${info.port}`));
}

// The gateway listener: only requests carrying the gateway's secret, and never the hook endpoints
// (those are for the local `claude` processes, on loopback).
if (config.gatewayHost) {
  const secret = Buffer.from(config.gatewaySecret);
  if (secret.length < 32) {
    console.error('FLIGHTDECK_GATEWAY_HOST is set but FLIGHTDECK_GATEWAY_SECRET is missing or short — gateway listener NOT started');
  } else {
    const fromGateway = (req: Request) => {
      const got = Buffer.from(req.headers.get('x-flightdeck-gateway') ?? '');
      return got.length === secret.length && timingSafeEqual(got, secret);
    };
    serve({
      hostname: config.gatewayHost,
      port: config.port,
      fetch: req => {
        if (new URL(req.url).pathname.startsWith('/hook')) return new Response('not found', { status: 404 });
        if (!fromGateway(req)) return new Response('forbidden', { status: 403 });
        return app.fetch(req);
      },
    }, info => console.log(`flightdeck gateway listener on http://${config.gatewayHost}:${info.port} (secret header required)`));
  }
}
