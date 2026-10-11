// Maps: an agent reads the code (read-only) and returns a diagram as structured output;
// Flightdeck validates it and writes `.flightdeck/<view>.json` into the repo (see mapsDir).
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ClaudeEvent, GeneratedMap, MAP_VIEWS, StoredMap,
  type MapEdge, type MapJob, type MapNode, type MapViewId,
} from '../shared/contracts.ts';
import { config } from './config.ts';
import { evaluate, type Verdict } from './rules.ts';

const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------------------------

const COMMON = `You are mapping the codebase in the current directory for Flightdeck, a tool that shows a
project as diagrams the reader navigates instead of a file tree. Explore the repository READ-ONLY:
start with \`git ls-files\`, read README / CLAUDE.md, manifests and entry points, then the code
that matters. Then return the map through the structured output. Rules:

- Only include what exists in this code. No guesses, plans or aspirations.
- id: short kebab-case, unique across the whole map.
- parent: null for top-level nodes, otherwise the id of the node it belongs to. Children let the
  reader drill in: 4-12 top-level nodes, and 0-10 children for a node big enough to deserve them.
  At most 3 levels.
- label: 1-4 words. summary: one plain sentence — what it is and why it exists.
- files: repo-relative paths that implement the node — files, or directories ending in "/". Every
  node needs at least one, and they must exist: they drive change detection and the file viewer.
  Prefer the narrowest directory that covers the node.
- edges: from/to are node ids at ANY level; label says what flows ("HTTP /api/orders",
  "enqueues SendEmail", "reads users"). Connect the most specific nodes that are accurate; the
  viewer lifts edges to whatever level is on screen. evidence: for every edge you traced in the
  code, the repo-relative file and line of the statement that makes the call/read/write — the
  call itself, not an import ("src/api/client.ts:42"). Most edges should have one: you found
  them by reading code. Omit it only for an edge you did not see in code; never guess a file or
  line. An edge without evidence is shown to the reader as inferred.
- fields: an empty array unless the view below says otherwise.`;

const VIEW_PROMPTS: Record<MapViewId, string> = {
  architecture: `VIEW: ARCHITECTURE. Nodes are the system's runtime and structural parts: apps and services,
workers, UIs, modules, data stores, queues, caches, and the external services/APIs it calls.
kind is one of: app, service, worker, ui, module, datastore, queue, external, library —
ui: a web front-end; app: a mobile, desktop or CLI application; service: a server process that
answers requests; worker: a process that runs jobs or schedules; module: an internal part of an
app or service; library: shared code packaged for reuse; datastore: a database, file store or
cache; queue: a message queue or job table; external: anything not in this repository.
For external services, files = where they are called from. Edges are calls, reads/writes,
publishes/consumes.`,
  'data-model': `VIEW: DATA MODEL. Nodes are persisted entities — tables, collections, models — with kind
"table"; group them under parent nodes (kind "group") for schemas or domains when there are more
than about 12. fields: the important columns (name, type, note such as "PK", "FK -> users.id",
"unique"); skip plain timestamps. files: the migrations and the model/schema files. Edges are
relations, from the referencing table to the referenced one, labelled like "N:1 user_id".
If the project persists no data, return a single node of kind "note" that says so.`,
  flows: `VIEW: FLOWS. Top-level nodes are the important end-to-end flows a reader should understand
(kind "flow"): a user request, a background job, a webhook, a scheduled task — 3-10 of them,
most important first. Each flow's children are its steps (kind "step"), each pointing at the
code that performs it; edges connect consecutive steps (label = what is passed, may be empty)
and may branch. A flow node's files = its entry point.`,
};

// ---------------------------------------------------------------------------------------------
// The generator's tool policy: read-only, enforced by its own hook (so the box's global allow
// rules — e.g. `sudo systemctl *` — never apply), plus --disallowedTools as a second wall.
// ---------------------------------------------------------------------------------------------

const GENERATOR_RULES = [
  ...['Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'StructuredOutput'].map(pattern => ({ bucket: 'allow' as const, pattern, reason: null })),
  ...['git ls-files', 'git log', 'git show', 'ls', 'wc', 'head', 'cat'].map(c => ({ bucket: 'allow' as const, pattern: `Bash(${c}:*)`, reason: null })),
];

export function generatorDecision(toolName: string, input: Record<string, unknown>, projectPath: string): Verdict {
  const v = evaluate(GENERATOR_RULES, toolName, input, projectPath);
  return v.bucket === 'allow' ? v : { bucket: 'deny' }; // no cards while mapping: not allowed = refused
}

// ---------------------------------------------------------------------------------------------
// Validation (pure): structural problems reject the map; bad file paths and edges are dropped
// with a warning.
// ---------------------------------------------------------------------------------------------

export function validateMap(gen: { nodes: MapNode[]; edges: MapEdge[] }, repoFiles: string[]):
  { ok: true; nodes: MapNode[]; edges: MapEdge[]; warnings: string[] } | { ok: false; error: string } {
  const warnings: string[] = [];
  if (gen.nodes.length === 0) return { ok: false, error: 'the map has no nodes' };
  if (gen.nodes.length > 400) return { ok: false, error: `the map has ${gen.nodes.length} nodes (max 400)` };

  const ids = new Set<string>();
  for (const n of gen.nodes) {
    if (ids.has(n.id)) return { ok: false, error: `duplicate node id "${n.id}"` };
    ids.add(n.id);
  }
  const byId = new Map(gen.nodes.map(n => [n.id, n]));
  for (const n of gen.nodes) {
    if (n.parent !== null && !byId.has(n.parent)) return { ok: false, error: `node "${n.id}" has unknown parent "${n.parent}"` };
    const seen = new Set<string>();
    for (let p: string | null = n.id; p !== null; p = byId.get(p)?.parent ?? null) {
      if (seen.has(p)) return { ok: false, error: `parent cycle at "${n.id}"` };
      seen.add(p);
    }
  }

  const files = new Set(repoFiles);
  const exists = (f: string) => (f.endsWith('/') ? repoFiles.some(r => r.startsWith(f)) : files.has(f));
  let dropped = 0;
  const nodes = gen.nodes.map(n => ({
    ...n,
    files: [...new Set(n.files.map(f => {
      let p = f.trim().replace(/^\.\//, '').replace(/^\/+/, '');
      if (!p.endsWith('/') && !files.has(p) && repoFiles.some(r => r.startsWith(p + '/'))) p += '/';
      return p;
    }))].filter(f => {
      const ok = f !== '' && exists(f);
      if (!ok) dropped++;
      return ok;
    }),
  }));
  if (dropped) warnings.push(`${dropped} file reference(s) did not exist in the repo and were dropped`);

  const seenEdges = new Set<string>();
  const kept = gen.edges.filter(e => {
    const key = `${e.from}→${e.to}→${e.label}`;
    const ok = byId.has(e.from) && byId.has(e.to) && e.from !== e.to && !seenEdges.has(key);
    seenEdges.add(key);
    return ok;
  });
  if (kept.length < gen.edges.length) warnings.push(`${gen.edges.length - kept.length} edge(s) pointed at unknown nodes or repeated and were dropped`);
  // Evidence must point at a real file; otherwise the edge stays, marked as inferred.
  let unproven = 0;
  const edges = kept.map(({ evidence, ...e }) => {
    const ev = evidence?.trim().replace(/^\.\//, '').replace(/^\/+/, '');
    const m = ev ? /^(.*?)(?::(\d+))?$/.exec(ev) : null;
    if (m && files.has(m[1]!)) return { ...e, evidence: m[2] ? `${m[1]}:${m[2]}` : m[1] };
    if (ev) unproven++;
    return e;
  });
  if (unproven) warnings.push(`${unproven} edge citation(s) named files that don't exist; those edges are shown as inferred`);

  return { ok: true, nodes, edges, warnings };
}

// Which nodes cover a changed file — plus their ancestors, so staleness shows at every level.
export function staleNodeIds(nodes: MapNode[], changed: string[]): string[] {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const stale = new Set<string>();
  for (const n of nodes) {
    const hit = n.files.some(f => changed.some(c => (f.endsWith('/') ? c.startsWith(f) : c === f)));
    if (!hit) continue;
    for (let p: string | null = n.id; p !== null; p = byId.get(p)?.parent ?? null) stale.add(p);
  }
  return [...stale];
}

// ---------------------------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------------------------

// Maps only read the repo, but `git diff <commit>` (and Claude's own git calls) still rewrite
// .git/index to refresh its cache. Syncthing carries .git between the box and the Mac, so that write
// can land on top of a commit made on the Mac. Everything here works on a scratch copy of the index
// instead (GIT_INDEX_FILE); GIT_OPTIONAL_LOCKS=0 alone only covers `git status`.
function scratchIndex(repo: string): { env: NodeJS.ProcessEnv; done: () => void } {
  const file = join(tmpdir(), `flightdeck-index-${randomUUID()}`);
  const real = join(repo, '.git', 'index');
  if (existsSync(real)) {
    copyFileSync(real, file);
    // Keep the index's own mtime: git compares it with each file's mtime to catch edits made in the
    // same instant the index was written ("racy git"). A fresh mtime makes those edits look clean.
    const st = statSync(real);
    utimesSync(file, st.atime, st.mtime);
  }
  return {
    env: { ...process.env, GIT_INDEX_FILE: file, GIT_OPTIONAL_LOCKS: '0' },
    done: () => rmSync(file, { force: true }),
  };
}

export function git(cwd: string, args: string[]): string {
  const idx = scratchIndex(cwd);
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20, env: idx.env });
  } finally {
    idx.done();
  }
}

// A project is one git repository, or a folder whose direct subfolders are repositories (an API, a
// web app and a mobile app side by side). Returns the repositories relative to the project; [''] means
// the project folder is itself the repository.
export function repoDirs(path: string): string[] {
  if (existsSync(join(path, '.git'))) return [''];
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.') && existsSync(join(path, e.name, '.git')))
      .map(e => e.name)
      .sort();
  } catch {
    return [];
  }
}
const isSingleRepo = (path: string) => repoDirs(path)[0] === '';

const lsFiles = (path: string) => git(path, ['ls-files', '-co', '--exclude-standard']).split('\n').filter(Boolean);

// Files directly in a multi-repo folder (its shared CLAUDE.md, README…), outside every repository.
function looseFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).filter(e => e.isFile() && !e.name.startsWith('.')).map(e => e.name);
}

// Every file in the project, relative to it. In a multi-repo folder: each repository's files under its
// folder name, plus the loose top-level files. Other non-repository subfolders are left out.
export function repoFiles(path: string): string[] {
  if (isSingleRepo(path)) return lsFiles(path);
  const files = looseFiles(path);
  for (const r of repoDirs(path)) files.push(...lsFiles(join(path, r)).map(f => `${r}/${f}`));
  return files;
}

export function head(path: string): string | null {
  try { return git(path, ['rev-parse', 'HEAD']).trim(); } catch { return null; }
}

// What a map records to detect change later: HEAD, or each repository's HEAD in a multi-repo folder.
function heads(path: string): { commit: string | null; commits?: Record<string, string> } {
  if (isSingleRepo(path)) return { commit: head(path) };
  const commits: Record<string, string> = {};
  for (const r of repoDirs(path)) {
    const h = head(join(path, r));
    if (h) commits[r] = h;
  }
  return { commit: null, commits };
}

// Files changed since the map was made, committed or not. `null` = a commit it was made from is gone.
export function changedSince(path: string, map: Pick<StoredMap, 'commit' | 'commits' | 'generatedAt'>): string[] | null {
  if (!map.commits) return repoChangedSince(path, map.commit);
  const out: string[] = [];
  for (const r of repoDirs(path)) {
    const commit = map.commits[r];
    // A repository added (or first committed) since the map: everything in it is new.
    if (!commit) { out.push(...lsFiles(join(path, r)).map(f => `${r}/${f}`)); continue; }
    const since = repoChangedSince(join(path, r), commit);
    if (since === null) return null;
    out.push(...since.map(f => `${r}/${f}`));
  }
  // Loose top-level files have no git history; go by modification time.
  const at = Date.parse(map.generatedAt);
  out.push(...looseFiles(path).filter(f => statSync(join(path, f)).mtimeMs > at));
  return out;
}

function repoChangedSince(path: string, commit: string | null): string[] | null {
  if (!commit) return null;
  try { git(path, ['cat-file', '-e', `${commit}^{commit}`]); } catch { return null; }
  const diff = git(path, ['diff', '--name-only', commit, '--']).split('\n');
  const untracked = git(path, ['ls-files', '--others', '--exclude-standard']).split('\n');
  return [...new Set([...diff, ...untracked])].filter(f => f && !f.startsWith('.flightdeck/'));
}

// ---------------------------------------------------------------------------------------------
// Stored maps
// ---------------------------------------------------------------------------------------------

// Where a project's maps live: <project>/.flightdeck/, or — for a multi-repo folder that keeps them
// in one of its repositories, so they're under git — <project>/<repo>/.flightdeck/<folder name>/.
// The extra folder keeps them apart from that repo's own maps if it's ever a project by itself.
export function mapsDir(project: { path: string; mapsRepo: string | null }): string {
  return project.mapsRepo
    ? join(project.path, project.mapsRepo, '.flightdeck', basename(project.path))
    : join(project.path, '.flightdeck');
}
const mapFile = (dir: string, view: MapViewId) => join(dir, `${view}.json`);

// Move a project's map files to a new place (when its mapsRepo setting changes). A view that
// already has a map at the destination keeps that one. Returns the views moved.
export function moveMaps(from: string, to: string): MapViewId[] {
  const moved: MapViewId[] = [];
  for (const { id } of MAP_VIEWS) {
    const src = mapFile(from, id), dst = mapFile(to, id);
    if (!existsSync(src) || existsSync(dst)) continue;
    mkdirSync(to, { recursive: true });
    renameSync(src, dst);
    moved.push(id);
  }
  return moved;
}

export function readMap(dir: string, view: MapViewId): StoredMap | null {
  const f = mapFile(dir, view);
  if (!existsSync(f)) return null;
  const parsed = StoredMap.safeParse(JSON.parse(readFileSync(f, 'utf8')));
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------------------------
// Generation jobs (one at a time per project)
// ---------------------------------------------------------------------------------------------

// The CLI's validator doesn't know the 2020-12 meta-schema Zod declares by default.
function mapJsonSchema() {
  const { $schema: _drop, ...schema } = z.toJSONSchema(GeneratedMap, { target: 'draft-7' }) as Record<string, unknown>;
  return schema;
}

type Job = MapJob & { projectId: number; sessionId?: string; proc?: ChildProcess; stopRequested: boolean };
const jobs = new Map<number, Job>(); // latest job per project

export const jobFor = (projectId: number): MapJob | null => {
  const j = jobs.get(projectId);
  if (!j) return null;
  const { projectId: _p, sessionId: _s, proc: _c, stopRequested: _r, ...pub } = j;
  return pub;
};
export const jobForSession = (sessionId: string) => [...jobs.values()].find(j => j.sessionId === sessionId && j.status === 'running');

function describe(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash') return `$ ${String(input.command ?? '')}`;
  if (name === 'Read') return `Read ${String(input.file_path ?? '')}`;
  if (name === 'Grep') return `Search “${String(input.pattern ?? '')}”`;
  if (name === 'Glob') return `Find ${String(input.pattern ?? '')}`;
  if (name === 'StructuredOutput') return 'Writing the map';
  return name;
}

// hints: extra prompt text (a plan check's id alignment); the generator still maps only what exists.
export function startGeneration(project: { id: number; path: string; discussModel: string; mapsRepo: string | null }, view: MapViewId, hints = ''):
  { ok: true } | { ok: false; error: string } {
  if (jobs.get(project.id)?.status === 'running') return { ok: false, error: 'a map is already being generated for this project' };

  const job: Job = {
    projectId: project.id, view, status: 'running', startedAt: now(), endedAt: null, steps: 0,
    activity: 'Starting…', error: null, stopRequested: false,
  };
  jobs.set(project.id, job);
  const { commit, commits } = heads(project.path);
  const repos = repoDirs(project.path);
  // In a multi-repo folder git only works inside each repository; say so, or the agent starts with a
  // `git ls-files` at the top that fails.
  const layout = repos[0] === '' ? '' : `\n\nThis project is a folder of ${repos.length} separate git repositories: ${repos.join(', ')}. ` +
    'Treat them as one system. git commands only work inside a repository, so explore with Glob, Grep, Read and ls; ' +
    'file paths in the map are relative to this folder (e.g. `' + repos[0] + '/…`).';

  const args = [
    '-p', `${COMMON}\n\n${VIEW_PROMPTS[view]}${layout}${hints ? `\n\n${hints}` : ''}`,
    '--model', project.discussModel,
    '--output-format', 'stream-json', '--verbose',
    '--json-schema', JSON.stringify(mapJsonSchema()),
    '--disallowedTools', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch',
    '--settings', JSON.stringify({
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{
        type: 'http', url: `http://${config.host}:${config.port}/hook/map`, timeout: 60, onFailure: 'block',
      }] }] },
    }),
  ];
  // A scratch index is per repository; in a multi-repo folder there's no single one to copy, so git's
  // optional index writes are switched off instead (that covers `git status`, the common case).
  const idx = repos[0] === '' ? scratchIndex(project.path) : { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, done: () => {} };
  const env = idx.env;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const proc = spawn(config.claudeBin, args, { cwd: project.path, env, stdio: ['ignore', 'pipe', 'pipe'] });
  job.proc = proc;
  proc.on('close', idx.done);
  proc.on('error', idx.done);

  const fail = (error: string) => {
    if (job.status === 'running') Object.assign(job, { status: 'failed', error, endedAt: now() });
  };
  let stderr = '';
  proc.stderr!.on('data', d => (stderr = (stderr + d.toString()).slice(-2000)));

  createInterface({ input: proc.stdout! }).on('line', line => {
    let ev: ClaudeEvent;
    try {
      const parsed = ClaudeEvent.safeParse(JSON.parse(line));
      if (!parsed.success) return;
      ev = parsed.data as ClaudeEvent;
    } catch { return; }

    if (ev.type === 'system' && ev.subtype === 'init') {
      job.sessionId = String(ev.session_id);
      if (ev.apiKeySource !== 'none') {
        fail(`refused: session is not on the subscription (apiKeySource=${String(ev.apiKeySource)})`);
        proc.kill('SIGINT');
      }
    } else if (ev.type === 'assistant') {
      const content = (ev.message as { content?: { type: string; name?: string; input?: Record<string, unknown> }[] })?.content ?? [];
      for (const c of content) {
        if (c.type !== 'tool_use') continue;
        job.steps++;
        job.activity = describe(c.name ?? '', c.input ?? {});
      }
    } else if (ev.type === 'result') {
      if (ev.is_error) return fail(typeof ev.result === 'string' ? ev.result : `generation ended with ${ev.subtype}`);
      const gen = GeneratedMap.safeParse(ev.structured_output);
      if (!gen.success) return fail('the model returned a map that does not match the schema');
      const v = validateMap(gen.data, repoFiles(project.path));
      if (!v.ok) return fail(`map rejected: ${v.error}`);
      const stored: StoredMap = {
        version: 1, view, generatedAt: now(), commit, ...(commits ? { commits } : {}), model: project.discussModel,
        warnings: v.warnings, nodes: v.nodes, edges: v.edges,
      };
      mkdirSync(mapsDir(project), { recursive: true });
      writeFileSync(mapFile(mapsDir(project), view), JSON.stringify(stored, null, 2) + '\n');
      Object.assign(job, { status: 'done', endedAt: now(), activity: `Mapped ${v.nodes.length} nodes` });
      setTimeout(() => proc.exitCode === null && proc.kill('SIGINT'), 2000);
    }
  });

  proc.on('error', err => fail(`could not start claude: ${err.message}`));
  proc.on('close', code => {
    if (job.status !== 'running') return;
    if (job.stopRequested) Object.assign(job, { status: 'stopped', endedAt: now() });
    else fail(`claude exited (${code}) without a map. ${stderr.trim()}`.trim());
  });
  return { ok: true };
}

export function stopGeneration(projectId: number): boolean {
  const j = jobs.get(projectId);
  if (!j || j.status !== 'running' || !j.proc) return false;
  j.stopRequested = true;
  j.proc.kill('SIGINT');
  return true;
}
