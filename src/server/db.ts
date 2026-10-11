// SQLite (WAL) via Drizzle. Holds metadata only; each chat's full feed lives in a JSONL file.
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';

export const projects = sqliteTable('projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  path: text('path').notNull().unique(),
  discussModel: text('discuss_model').notNull(),
  buildModel: text('build_model').notNull(),
  // Multi-repo folders: the repository (subfolder) whose .flightdeck/ keeps the maps; null = the folder itself.
  mapsRepo: text('maps_repo'),
  createdAt: text('created_at').notNull(),
});

export const rules = sqliteTable('rules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  bucket: text('bucket', { enum: ['allow', 'ask', 'deny'] }).notNull(),
  pattern: text('pattern').notNull(),
  reason: text('reason'),
});

export const chats = sqliteTable('chats', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  title: text('title').notNull(),
  sessionId: text('session_id').notNull().unique(),
  started: integer('started', { mode: 'boolean' }).notNull().default(false), // first turn sent?
  mode: text('mode', { enum: ['discuss', 'build'] }).notNull(),
  discussModel: text('discuss_model'), // null = the project's default
  buildModel: text('build_model'), // null = the project's default
  createdAt: text('created_at').notNull(),
});

export const runs = sqliteTable('runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  status: text('status', { enum: ['running', 'finished', 'failed', 'stopped'] }).notNull(),
  detail: text('detail'),
  planVersionId: integer('plan_version_id'), // the approved plan version a Build turn implemented
  headBefore: text('head_before'),
  headAfter: text('head_after'),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at'),
});

// Plans (PLAN.md §10): one per chat; its versions are insert-only (a trigger below refuses edits).
export const plans = sqliteTable('plans', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull().unique(),
  projectId: integer('project_id').notNull(),
  status: text('status', { enum: ['draft', 'approved', 'done', 'dropped'] }).notNull(),
  approvedVersionId: integer('approved_version_id'), // what Build turns implement; changes only on Approve
  createdAt: text('created_at').notNull(),
});

export const planVersions = sqliteTable('plan_versions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  planId: integer('plan_id').notNull(),
  version: integer('version').notNull(),
  source: text('source', { enum: ['agent', 'revalidated'] }).notNull(),
  body: text('body').notNull(), // PlanBody JSON
  baseline: text('baseline').notNull(), // PlanBaseline JSON
  warnings: text('warnings').notNull(), // JSON string[]
  // The maps it was made against, as they were (JSON, view → StoredMap | null): what a check compares
  // the regenerated maps with — the files on disk may have been regenerated since.
  maps: text('maps'),
  createdAt: text('created_at').notNull(),
  approvedAt: text('approved_at'), // set once, never cleared
});

// Checks of what was built against an approved version (PLAN.md §10). result: PlanCheck fields as JSON.
export const planChecks = sqliteTable('plan_checks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  planId: integer('plan_id').notNull(),
  versionId: integer('version_id').notNull(),
  status: text('status', { enum: ['running', 'done', 'failed'] }).notNull(),
  result: text('result').notNull(),
  createdAt: text('created_at').notNull(),
});

// Approved revisions of the requirements documents (PLAN.md §11). The documents are files in the
// repository; what was approved is kept here, insert-only, so neither an edit to the file nor the
// agent can change it after the fact. A later approval of the same document supersedes the earlier one.
export const requirementApprovals = sqliteTable('requirement_approvals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  path: text('path').notNull(), // relative to docs/requirements: PRD.md, features/<slug>.md
  version: integer('version').notNull(), // 1, 2, … per document
  hash: text('hash').notNull(), // sha256 of the content
  content: text('content').notNull(),
  ids: text('ids').notNull(), // JSON string[]: the requirement ids it contains
  approvedAt: text('approved_at').notNull(),
});

// The audit trail: every tool call the hook decided, and who/what decided it.
export const approvals = sqliteTable('approvals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: integer('run_id').notNull(),
  toolName: text('tool_name').notNull(),
  toolInput: text('tool_input').notNull(), // JSON
  decision: text('decision', { enum: ['pending', 'allowed', 'denied'] }).notNull(),
  decidedBy: text('decided_by'), // user | rule | timeout | lock
  rule: text('rule'),
  reason: text('reason'),
  createdAt: text('created_at').notNull(),
  decidedAt: text('decided_at'),
});

mkdirSync(join(config.dataDir, 'chats'), { recursive: true });
const sqlite = new Database(join(config.dataDir, 'flightdeck.db'));
sqlite.pragma('journal_mode = WAL');

// Phase 1a keeps the schema as boot-time DDL; migrations arrive with the first schema change.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
    discuss_model TEXT NOT NULL, build_model TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, bucket TEXT NOT NULL,
    pattern TEXT NOT NULL, reason TEXT);
  CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, title TEXT NOT NULL,
    session_id TEXT NOT NULL UNIQUE, started INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL,
    discuss_model TEXT, build_model TEXT, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, status TEXT NOT NULL,
    detail TEXT, head_before TEXT, head_after TEXT, started_at TEXT NOT NULL, ended_at TEXT);
  CREATE TABLE IF NOT EXISTS approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, tool_name TEXT NOT NULL,
    tool_input TEXT NOT NULL, decision TEXT NOT NULL, decided_by TEXT, rule TEXT, reason TEXT,
    created_at TEXT NOT NULL, decided_at TEXT);
  CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL UNIQUE, project_id INTEGER NOT NULL,
    status TEXT NOT NULL, approved_version_id INTEGER, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS plan_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL, version INTEGER NOT NULL,
    source TEXT NOT NULL, body TEXT NOT NULL, baseline TEXT NOT NULL, warnings TEXT NOT NULL,
    created_at TEXT NOT NULL, approved_at TEXT, UNIQUE (plan_id, version));
  -- An approved plan can't be changed after the fact: a version's content is fixed once saved, and
  -- its approval, once given, stays. New thinking is a new version.
  CREATE TABLE IF NOT EXISTS plan_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL, version_id INTEGER NOT NULL,
    status TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS requirement_approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, path TEXT NOT NULL,
    version INTEGER NOT NULL, hash TEXT NOT NULL, content TEXT NOT NULL, ids TEXT NOT NULL,
    approved_at TEXT NOT NULL, UNIQUE (project_id, path, version));
  CREATE TRIGGER IF NOT EXISTS requirement_approvals_immutable
    BEFORE UPDATE ON requirement_approvals
    BEGIN SELECT RAISE(ABORT, 'approved requirements are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS requirement_approvals_no_delete
    BEFORE DELETE ON requirement_approvals
    BEGIN SELECT RAISE(ABORT, 'approved requirements are kept'); END;
  CREATE TRIGGER IF NOT EXISTS plan_versions_approval_once
    BEFORE UPDATE OF approved_at ON plan_versions WHEN OLD.approved_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'a plan version is approved once'); END;
  CREATE TRIGGER IF NOT EXISTS plan_versions_no_delete
    BEFORE DELETE ON plan_versions
    BEGIN SELECT RAISE(ABORT, 'plan versions are kept'); END;
`);

// Columns added after the first build (2026-10-10): bring an older database up to date.
const columns = (table: string) =>
  new Set((sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name));
const addColumn = (table: string, ddl: string) => {
  if (!columns(table).has(ddl.split(' ')[0]!)) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
};
addColumn('projects', `discuss_model TEXT NOT NULL DEFAULT '${config.defaultModel}'`);
addColumn('projects', `build_model TEXT NOT NULL DEFAULT '${config.defaultModel}'`);
addColumn('chats', `mode TEXT NOT NULL DEFAULT 'discuss'`);
addColumn('chats', 'discuss_model TEXT');
addColumn('chats', 'build_model TEXT');
addColumn('projects', 'maps_repo TEXT');
addColumn('runs', 'plan_version_id INTEGER');
addColumn('plan_versions', 'maps TEXT');
// After the columns exist, so the trigger covers all of them (recreated in case an older one lacks one).
sqlite.exec(`
  DROP TRIGGER IF EXISTS plan_versions_immutable;
  CREATE TRIGGER plan_versions_immutable
    BEFORE UPDATE OF plan_id, version, source, body, baseline, warnings, maps, created_at ON plan_versions
    BEGIN SELECT RAISE(ABORT, 'plan versions are immutable'); END;
`);
if (columns('chats').has('model')) sqlite.exec('ALTER TABLE chats DROP COLUMN model'); // superseded by per-mode models

// A run left 'running' by a crash or restart can never finish; close it out on boot.
sqlite
  .prepare(`UPDATE runs SET status='stopped', detail='flightdeck restarted', ended_at=? WHERE status='running'`)
  .run(new Date().toISOString());
sqlite
  .prepare(`UPDATE approvals SET decision='denied', decided_by='timeout', reason='flightdeck restarted', decided_at=? WHERE decision='pending'`)
  .run(new Date().toISOString());

export const db = drizzle(sqlite);
