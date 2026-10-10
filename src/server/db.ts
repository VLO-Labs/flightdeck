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
  model: text('model').notNull(),
  createdAt: text('created_at').notNull(),
});

export const runs = sqliteTable('runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  status: text('status', { enum: ['running', 'finished', 'failed', 'stopped'] }).notNull(),
  detail: text('detail'),
  headBefore: text('head_before'),
  headAfter: text('head_after'),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at'),
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
    created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, bucket TEXT NOT NULL,
    pattern TEXT NOT NULL, reason TEXT);
  CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, title TEXT NOT NULL,
    session_id TEXT NOT NULL UNIQUE, started INTEGER NOT NULL DEFAULT 0, model TEXT NOT NULL,
    created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, status TEXT NOT NULL,
    detail TEXT, head_before TEXT, head_after TEXT, started_at TEXT NOT NULL, ended_at TEXT);
  CREATE TABLE IF NOT EXISTS approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, tool_name TEXT NOT NULL,
    tool_input TEXT NOT NULL, decision TEXT NOT NULL, decided_by TEXT, rule TEXT, reason TEXT,
    created_at TEXT NOT NULL, decided_at TEXT);
`);

// A run left 'running' by a crash or restart can never finish; close it out on boot.
sqlite
  .prepare(`UPDATE runs SET status='stopped', detail='flightdeck restarted', ended_at=? WHERE status='running'`)
  .run(new Date().toISOString());
sqlite
  .prepare(`UPDATE approvals SET decision='denied', decided_by='timeout', reason='flightdeck restarted', decided_at=? WHERE decision='pending'`)
  .run(new Date().toISOString());

export const db = drizzle(sqlite);
