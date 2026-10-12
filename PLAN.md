# Flightdeck — plan

## 1. The idea

Hayk works at the level of architecture and direction, not hands-on code, using Claude Code
and cursor-agent in the terminal. What's missing is the **visual**: the system can't be seen,
and hand-drawn diagrams (Lucidchart) are a separate step that goes stale the moment code changes.

Flightdeck is an **IDE rebuilt for someone who directs code rather than reads it**:

| Traditional IDE | Flightdeck |
|---|---|
| File tree | **Diagrams** — architecture, data model, flows, generated from the code. You navigate the system, not folders |
| Code editor | **Chats** — several per project, each a Claude Code session. Code is viewable read-only when wanted |
| Workspaces | **Projects** — switch between repos, each with its own diagrams and chats |

It's for **seeing what exists and steering it**, not drawing designs by hand — the diagrams
are produced by the agent from the code, never authored.

## 2. Decisions

| Decision | Choice | Why | Status |
|---|---|---|---|
| Home | Own repo, not an HQ module | HQ is the business back-office; this is a dev tool | decided |
| Repo | `~/dev/vlolabs/flightdeck`, private `VLO-Labs/flightdeck` on GitHub | — | decided |
| Runs on | **The box**, everything (UI + backend) | The `claude` CLI, its login, the repos and long-running agent processes all live there; Workers can't run a CLI. Splitting the UI onto Pages adds auth on two sides for no gain | decided |
| Front door | Cloudflare Tunnel + the shared SSO gateway, service bound to **loopback** | It is effectively a shell with Hayk's credentials — never public | decided |
| Process model | **Native systemd service** as `vlolabs`, not Docker | The agent needs the real environment: `~/dev`, `claude` login, `gh`, `make`. A container would mount all of it back in | decided |
| Engine | Claude Code CLI only | cursor-agent later, as a second engine behind the same UI | decided |
| Billing | Claude **subscription** via the CLI's own login | See §5 | decided |
| Permissions | **Approval cards** in the page | Same experience as the terminal's prompts | decided |
| Parallel chats | **One chat at a time may change code**; others read/discuss/plan | Two agents editing one working tree collide (files, commits, test noise). Worktree-per-chat can come later | decided |
| Language | TypeScript throughout — Hono (Node 22), Vite + React + React Flow; contracts as Zod schemas shared by server and UI | The spike showed the shared contracts (stream events, hook payload, map schema) are the delicate part; one definition means drift fails the compile instead of failing silently. Go was weighed: its single binary and process handling are real strengths, but they pay off at a scale Flightdeck won't reach | **decided 2026-10-10** |
| Storage | SQLite (WAL) via Drizzle; run logs as files | Flightdeck must keep working when Docker/Postgres is down — that's when you'd open it. One user, one process. Switch to Postgres only if multi-user or vector search is needed | working assumption |
| Port | `127.0.0.1:8100` (free as of 2026-10-10) | — | proposed |
| **Runs on (now)** | **Locally on Hayk's Mac as Flightdeck.app**, loopback only; updated with `scripts/mac/install.sh` (see README) | Replaces the box, tunnel, SSO gateway and systemd rows above, which are kept as history. The app runs its own copy of the code, so chats editing this repo can't change the running server | **decided 2026-10-11** |

## 3. Architecture

```mermaid
flowchart LR
  B[Browser] -->|HTTPS| CF[Cloudflare Tunnel + SSO]
  CF --> FD

  subgraph BOX[vlolabsdev]
    FD[Flightdeck server<br/>127.0.0.1:8100<br/>serves UI · API · SSE]
    DB[(SQLite<br/>projects · chats · runs · approvals)]
    LOGS[/run logs<br/>/data/flightdeck/runs/*.jsonl/]
    CLI[claude -p<br/>one process per turn]
    REPO[(repo in ~/dev/...<br/>+ .flightdeck/ maps)]
    FD --- DB
    FD --- LOGS
    FD -->|spawn, cwd = repo,<br/>API key stripped| CLI
    CLI -->|stream-json events| FD
    CLI -->|PreToolUse hook<br/>HTTP, held until you click| FD
    CLI -->|reads / edits| REPO
    FD -->|reads maps + files| REPO
  end

  CLI -->|subscription login| ANT[Anthropic]
```

- **One service** serves the UI, the API and live streams (Server-Sent Events; output only flows
  one way, so no WebSockets).
- **Agent history lives in Claude Code's own session files** on the box. Flightdeck stores only
  pointers and metadata.

## 4. How a chat works

```mermaid
sequenceDiagram
  participant U as You (browser)
  participant F as Flightdeck
  participant C as claude -p
  U->>F: message + selected diagram nodes
  F->>F: build prompt (message + node context blocks)
  F->>C: spawn: --resume <session> --output-format stream-json ...
  loop while working
    C-->>F: events (text, tool calls, results)
    F-->>U: live text · activity lines · lit-up nodes
    C->>F: PreToolUse hook: "may I run X?"
    F-->>U: approval card
    U->>F: Allow / Deny (+ reason)
    F->>C: decision
  end
  C-->>F: result event, process exits
  F-->>U: summary of changes, affected nodes marked, maps marked stale
```

**Per turn.** Each message spawns one process in the project's repo folder:

```
claude -p "<prompt>" --resume <session-id> \
  --output-format stream-json --verbose --include-partial-messages \
  --settings <flightdeck hook config>  < /dev/null
```

The first turn uses `--session-id <uuid>` (generated by Flightdeck) instead of `--resume`. The
repo's `CLAUDE.md` loads automatically because cwd = the repo. Docs call one-process-per-turn
the simplest and most crash-safe pattern (vs a long-lived stdin `stream-json` process).
`--verbose` is **required** with `stream-json` (the CLI refuses otherwise), and stdin must be
closed (`< /dev/null`) or the CLI waits 3 s for piped input and prints a non-JSON warning.

**Reading the result (spike-verified).**
- **Judge a run by `result.is_error`, never by `result.subtype`.** A run with a bad API key
  reported `subtype: "success"` with `is_error: true`.
- **`result` ends the turn, not the process.** If the agent started a background task, the
  process stays alive after `result` (the task is reported via `system` `task_*` events). The
  chat is "done" at `result`; Flightdeck then decides what to do with leftover background tasks
  (Phase 1: SIGINT the process — that kills them, reported as `task_updated: killed`).
- **Show `permission_denied` events and denied `tool_result`s yourself.** In the spike the agent
  claimed "the command ran and created the file" when it had been refused. The activity lines
  are the truth; the agent's closing summary is not.
- A `rate_limit_event` arrives each turn with the subscription's five-hour window status and
  reset time — the UI can show remaining headroom.
  *As built:* the chat header shows it next to the chat's token use: "context 32k / 1M · 272k used".
  Context is the latest main-agent call's `usage` (input + cache read + cache write + output;
  subagent calls carry `parent_tool_use_id` and are skipped); the window comes from the turn's
  `result.modelUsage[model].contextWindow`; "used" is new input (uncached + cache writes) plus
  output, added up over each finished turn's `result.usage` — cache reads are left out (the same
  conversation re-read on every call; they'd be ~95% of it) and only shown in the tooltip. A stopped
  turn has no result, so it isn't counted. Warn colour at 80% full. A clock sits in
  the sidebar next to the name.

**Node context.** Each diagram node selected as context becomes a short block in the prompt:
name, one-line summary, the files it covers — so "this" is unambiguous.

**What you see.** Text streams word by word. Tool calls become collapsed activity lines
("Read `app/Jobs/X.php`", "Edited 2 files", "Ran tests"). Files read/edited light up the
diagram nodes that own them.

**Stop.** Send **SIGINT** — the turn ends cleanly. (SIGTERM leaves the turn unrecorded.)
Spike: the process exited within 1 s of SIGINT mid-command, recorded
`[Request interrupted by user]`, and ended with `result.subtype: error_during_execution`.

**Reopen.** A chat replays its saved event log. Chats are ordinary Claude Code sessions, so
`claude --resume <id>` in an SSH terminal continues one there too. Spike: resuming an
interrupted session keeps the same `session_id` and the agent knows what was interrupted.

### Approval cards
A **`PreToolUse` hook of type `http`**, passed via `--settings`, calls Flightdeck before every
tool use. Flightdeck answers `allow` or `deny` (with a reason the agent sees, or with an
`updatedInput`). While a card is open, the HTTP request is held and the agent waits.

Spike-verified (Claude Code 2.1.289):
- Config: `{"hooks":{"PreToolUse":[{"matcher":"<tools>","hooks":[{"type":"http","url":"http://127.0.0.1:8100/hook","timeout":<seconds>}]}]}}`.
- **The agent waits.** Held 20 s → the command ran at the moment of the answer, not before.
- **The request carries what a card needs:** `session_id` (→ which chat), `tool_use_id` (→ the
  matching `tool_use` in the stream), `tool_name`, `tool_input` (incl. the agent's own
  `description` of the command), `cwd`, `permission_mode`.
- **Answer format:** `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"|"deny","permissionDecisionReason":"…"}}`.
  A hook `allow` lets the call run in `default` permission mode.
- **Deny reaches the agent verbatim** as the tool result
  (`PreToolUse:Bash hook error: <reason>`), and it relays it to you.
- **The `timeout` field is honoured** (5 s timed out at 5 s).

### Per-project approval rules
Each project has its own rules, edited in the project's settings page. Every rule puts a tool
call in one of three buckets:

| Bucket | Effect |
|---|---|
| **Allow** | Runs without asking |
| **Ask** | Approval card |
| **Deny** | Refused outright, with the rule's reason sent to the agent |

- **Rule syntax = Claude Code's own** (`Read`, `Edit`, `Bash(npm test:*)`, `Bash(git push:*)`,
  `WebFetch(domain:example.com)`), so rules mean exactly what they mean in the terminal.
- **Precedence: Deny > Ask > Allow**, matching Claude Code. Anything matching no rule → **Ask**.
- **"Always allow" on a card** adds an Allow rule for that command pattern to the project
  (shown before it's saved), the same as the terminal's "don't ask again".
- **New projects start from a template:**
  - Allow: reads and searches; file edits *by the chat holding the edit lock* (git makes them
    reviewable and revertible); `git status/diff/log`; the project's test command.
  - Ask: every other shell command; `git commit`; web fetches.
  - Deny: `git push --force`, `rm -rf` outside the repo, deploy commands (`make <target>`,
    `wrangler deploy`) — deploys are not in Phase 1 at all.
  - Per project, e.g. allow `git push` in a repo where you want that, or deny it on the
    Cloudflare Pages repos where a push to main *is* a deploy.
- **The edit lock sits above the rules:** a chat without the lock is denied edits whatever the
  rules say.

**The rules live in Flightdeck's database, never in the repo.** A rule file inside the repo
would be one the agent can edit — it could grant itself permissions. Flightdeck evaluates the
rules inside the hook, so the agent never sees or touches them. Every decision (rule-matched or
clicked) goes to the `approvals` audit table with the rule that decided it.

**On hook timeout the call falls back to Claude Code's normal permission rules** — not a blanket
deny (corrected by the spike; the first draft of this plan said "denied"). In headless `default`
mode that means: commands Claude Code classes as read-only (e.g. `date`) **run**; anything that
writes is **refused** with a `permission_denied` event (an `echo > file` was refused and the file
never appeared). So walking away can let read-only commands through but never a write. Flightdeck
sets the hook `timeout` explicitly (see Step 0 results for how long a card can stay open).
`"onFailure": "block"` would make a timeout a hard deny, but needs Claude Code ≥ 2.1.295 (box has
2.1.289). `--permission-prompt-tool` was rejected: its I/O schema is undocumented.
The hook's `defer` decision (process exits, resumes after you decide — survives a Flightdeck
restart) is a possible later upgrade; it only works for single-tool-call turns.

### The edit lock
"One chat at a time may change code" is enforced **in the same hook**: an edit-type tool call
from a chat that doesn't hold the project's lock is denied with "another chat is changing code
in this project" — the agent relays that. The lock is taken at a chat's first edit and released
when that run ends. Additionally, **a session never runs in two processes** (docs: transcripts
would interleave) — Flightdeck refuses a new turn while one is running.

## 5. Subscription, not API tokens

Verified against code.claude.com docs (authentication, headless, legal-and-compliance) on
2026-10-10:

- Headless `claude -p` with a subscription login (`/login`) and no API key **uses the subscription**.
- **In `-p` mode, `ANTHROPIC_API_KEY` always wins when present — silently.** Flightdeck strips
  `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the child environment. The UI shows which
  auth the session reported, as a tripwire.
- **Tripwire (spike-verified):** the `system`/`init` event's **`apiKeySource`** is `"none"` on the
  subscription and `"ANTHROPIC_API_KEY"` when a key is in the environment. Flightdeck **aborts the
  run** if it's anything but `"none"`.
- **Never `--bare`** — it ignores the subscription login.
- Box state 2026-10-10: Claude Code 2.1.289 installed at `~/.local/bin/claude`, logged in,
  no `ANTHROPIC_API_KEY` in the login env.
- Usage counts against the same plan limits as terminal sessions; limit errors are shown as-is.

**Terms.** Allowed: "an end user signing in to the unmodified Claude Code binary with their own
Claude subscription." Prohibited: offering a Claude.ai login to others, routing other users
through subscription credentials, collecting/storing/intermediating Claude.ai credentials. The
docs don't name personal self-built tools explicitly; Flightdeck stays inside the allowed case by
three rules:
1. it runs the **unmodified `claude` CLI** (not the Agent SDK, which the docs steer to API keys),
2. **only Hayk** uses it,
3. it **never reads or touches** `~/.claude/.credentials.json`.

If it ever serves anyone else, it moves to API-key auth.

## 6. Diagrams ("maps")

Three views per project in Phase 1: **architecture** (services, stores, external APIs, queues),
**data model** (tables and relations, from migrations/schema), **flows** (what happens when a
request or job runs through the system).

- **Generated by the agent.** A "Map this project" action runs `claude -p` with a fixed prompt
  and writes `.flightdeck/<view>.json` **in the repo** (committed, so the map travels with the
  code). Output is validated against the shared schema; invalid output is rejected, not drawn.
- **Schema (sketch):** nodes `{id, label, kind, summary, files[], children[]}`, edges
  `{from, to, label}`. `files` is what links a node to the code — it drives lit-up nodes, node
  context and staleness.
- **Drawn automatically** (React Flow + ELK layout) — nobody arranges boxes. Click a node to zoom
  into its children; click a leaf to see its files and summary.
- **Stale detection.** Each map records the git commit it was generated from. When files a node
  covers have changed since, the map shows a stale badge. A run that changed code ends by
  marking the map stale; refresh is one click.

### As built (2026-10-10)
- **Generation** = a fresh `claude -p` session in the project folder on the project's **Discuss
  model**, held to the map schema with **`--json-schema`** (the result arrives as
  `result.structured_output`; the CLI needs a draft-07 schema — Zod's default 2020-12 header is
  rejected). It gets **its own hook** (`/hook/map`) that allows only reading, searching and git
  inspection and refuses everything else without cards — because without a Flightdeck hook the
  box's global allow rules (`sudo systemctl *`, …) would apply — plus `--disallowedTools` for
  edits and the web. Flightdeck, not the agent, writes `.flightdeck/<view>.json`.
- **Schema is flat**: nodes carry a `parent` id instead of nesting (recursive JSON Schema is
  fragile for structured output). Edges may join nodes at any depth; the viewer lifts each edge
  to the visible ancestors of its ends.
- **Validation**: duplicate ids, unknown parents and parent cycles reject the map; file paths that
  don't exist and edges to unknown nodes are dropped with a warning shown on the map.
  Edges may cite `evidence` (the file, optionally `:line`, where the code makes that call; added
  2026-10-11). A citation is kept only if the file exists; the panel shows each relationship as
  **seen in code** (opens the file) or **inferred**. Maps made before then show all as inferred.
- **Change detection**: `git diff --name-only <map commit>` plus untracked files (excluding
  `.flightdeck/`), matched against node files (a directory covers everything under it); stale
  nodes and their ancestors are marked. If the map's commit no longer exists, every node is stale.
- **File viewer**: read-only, resolved with `realpath` and refused outside the project or inside
  `.git`; directories list git-known files.
- **First real run** — Flightdeck mapping itself on Opus 5.5: architecture 23 nodes in 50 s,
  data model and flows about a minute each, zero dropped references, and accurate on review.

## 7. Data

SQLite at `/data/flightdeck/flightdeck.db` (WAL):
`projects` (name, path) · `rules` (project, bucket, pattern, reason) ·
`chats` (project, title, session_id) ·
`runs` (chat, status, started/ended, git HEAD before/after, log path) ·
`approvals` (run, tool, input, decision, reason, decided_at — the audit trail).

Each chat's full feed (your messages, every Claude Code event, approval cards and their outcomes,
run start/end) goes to `/data/flightdeck/chats/<chat-id>.jsonl`, not into the DB — keeps the
database small for life, and reopening a chat is a replay of that file. (Built per chat rather
than the per-run files first planned: one file per chat makes replay a single read.) Backup =
copy the directory.

**Discuss / Build modes and their models (built 2026-10-10).** Each chat is in one of two modes,
switched in its header between turns:
- **Discuss** — read, analyze, plan. Edits are refused **in the hook** (`decidedBy: mode`), and
  the agent is told up front via `--append-system-prompt`, so it proposes instead of trying.
  Claude Code's own plan mode was not used: in headless runs its `ExitPlanMode` step would need
  an approval of its own.
  Shell commands too (2026-10-11): in Discuss, a shell command runs only when every command in
  the line is known read-only (`src/shared/shell.ts`: `git status/diff/log/show`, `ls`, `cat`,
  `grep`, `find` without `-exec`/`-delete`, `ps`, `lsof`, `curl` without writes, `<tool> --version`,
  …); anything else is **refused in the hook**, with no approval card, so a click can't let a
  Discuss chat change things (an earlier version asked, and an allowed `sed -i` edited `.env`).
- **Build** — may change code, and so takes the project's edit lock.

Both run in the **same session**, so flipping to Build keeps everything discussed ("go ahead"
is enough). Each mode has a model: **project defaults are Opus 5.5 for both** (`claude-opus-5-5`,
set in Project settings; `FLIGHTDECK_MODEL` changes the default for new projects), and a chat
can override either. Passed as `--model` per turn; every user turn records the mode and model
it ran with. New chats start in Discuss. The box's global Claude Code settings are untouched.

**Memory shared across chats (already there, via Claude Code).** Every chat runs in the project's
folder, so each turn loads the repo's `CLAUDE.md` and Claude Code's **auto-memory for that path**
(`~/.claude/projects/<path>/memory/`, reported in `init.memory_paths`). Something one chat saves
to memory, every other chat in the project — and terminal sessions on the box in that folder —
sees from its next turn. Conversations themselves stay per chat.

## 8. Build phases

**Step 0 — spike. DONE 2026-10-10** on the box (Claude Code 2.1.289, Node 22.23, `--model haiku`
to spare the plan; throwaway repo `/tmp/fd-spike`). Details are folded into §4 and §5.

| Question | Answer |
|---|---|
| `--verbose` required with `stream-json`? | **Yes** — hard error without it. Also close stdin (`< /dev/null`) |
| Does an `http` `PreToolUse` hook hold the agent? | **Yes** — command ran exactly when the hook answered |
| Is the hook `timeout` configurable? | **Yes** — 5 s honoured |
| Can a card stay open past the 600 s default? | _pending — 650 s hold with `timeout: 900` running_ |
| What happens on hook timeout? | **Falls back to normal rules, not a hard deny:** read-only commands run, writes are refused (`permission_denied`) |
| Deny with a reason? | Reason reaches the agent verbatim as the tool result |
| SIGINT mid-command? | Clean: exits in ~1 s, `[Request interrupted by user]`, `result.subtype: error_during_execution`; resume works and remembers it |
| Which auth is in use? | `init.apiKeySource`: `"none"` = subscription, `"ANTHROPIC_API_KEY"` = key → tripwire |
| Limit hit? | **Not testable on demand.** Every turn carries a `rate_limit_event` (status, window, reset time); the exhausted shape gets captured the first time it happens |

Surprises the build must respect: judge runs by `result.is_error` not `subtype`; `result` ends the
turn but background tasks keep the process alive; the agent's own summary can misreport a denied
action, so the UI shows denials from the stream; Claude Code itself refuses foreground `sleep`
and pushes long waits into background tasks.

**Phase 1a — chat. BUILT 2026-10-10** (dev instance on the box, see README). Projects (add by path), several chats per project, live streaming,
activity lines, approval cards, per-project approval rules, edit lock, stop, reopen. Usable on its own as a browser front
end to Claude Code.

**Phase 1b — maps. BUILT 2026-10-10.** Generation, schema validation, the three views, drill-down, stale badges,
read-only file viewing.

**Phase 1c — maps ↔ chat. BUILT 2026-10-10.** A map pane beside each chat (toggle in the header). **Context:** click a node to attach it as a chip; on send, the server resolves each `{view, nodeId}` from the map file on disk and prefixes the prompt with the node's label, kind, summary and files (the UI can only point at nodes, never inject text); unknown nodes are rejected. Verified: with the Rules Engine attached, the agent went straight to `src/server/rules.ts`. **Live highlighting:** the latest run's reads (blue) and successful edits (amber) map back to the most specific nodes covering each file and show on their visible ancestors; refused or failed edits light nothing. Claude Code reports **symlink-resolved paths** (`~/dev` → `/data/mac-sync/dev` on the box), so projects carry a `realPath`. The Map screen's node panel adds **Discuss in a new chat**. Original intent: Selecting nodes as chat context; nodes lighting up as the agent
reads/edits; post-run "what changed" marked on the map.

**Then** (superseded 2026-10-11: Flightdeck runs locally as Flightdeck.app, see §2 and README): a
`flightdeck.yml` playbook and `make flightdeck` in vlolabsdev-local, the tunnel route and the SSO
gateway entry.

## 9. Not in Phase 1
Git panel (commits/pushes happen in chat, as in the terminal today) · terminal · run/debug ·
problems panel · deploys and the deployment diagram view · GitHub integration · cursor-agent ·
worktree-per-chat parallel building · cross-project views.

## 10. Plan-first changes (design approved 2026-10-11)

Today the maps only show what **exists**. This adds the other direction: in a Discuss chat, the
agent draws what it **proposes** to build as a change to the maps; you review and steer it as a
picture; Build implements the approved version; then the result is checked against it, grounded
in the code and git, not only in a regenerated diagram.

```
Discuss: talk ──▶ agent submits a proposal (v1, v2, …) ──▶ map pane draws it over the current map
           ▲                                                   │ click boxes, ask for changes
           └───────────────────────────────────────────────────┘
Approve vN (frozen) ──▶ Build: every turn gets vN as its spec, and records that it used vN
                    ──▶ Verify: git changes + files + code citations + regenerated maps
                        ──▶ Verified / Missing / Unexpected / Needs review
```

It's for planning architecture and reviewing what got built, not a visual IDE: no diagram editor,
no drag-and-drop, no task tracker.

### Rules
1. **Source of truth stays separate.** Maps in `.flightdeck/<view>.json` are only ever written by
   generation from the code. A plan is a separate layer in Flightdeck's database, always drawn and
   labelled as *proposed*, and nothing in the planning path writes map files or source files.
2. **Every version records its baseline**: each repository's HEAD SHA, the working-tree changes at
   that moment (path + content hash of every modified or untracked file), and the `generatedAt` and
   commit of each map it refers to. Flightdeck compares that with now and reports: *fresh*;
   *code changed elsewhere* (changes that don't touch the plan's files); *stale* (changes touch
   files the plan covers); *map regenerated* (references are re-checked against the new map).
   A stale version can't be approved until it is **revalidated** (same content, checked against
   the current maps, saved as a new version with a new baseline) or revised by the agent.
3. **Readable overlay.** The current map's layout is kept; the plan adds to it. One set of markers
   everywhere: **added** (dashed outline, "new"), **changed** ("changed", before/after in the
   panel), **removed** (faded, struck through, kept in place), for boxes and arrows alike.
   An **All / Changes only** filter; under All, unchanged parts stay visible but subdued. Parents
   whose insides change say so, so drill-down finds changes. Clicking a box (planned or existing)
   attaches it to the message, as today.
4. **Approvals are immutable.** Versions are insert-only. Approving freezes one version id; Build
   turns are given that version and each run records which version it used. A later proposal makes
   a new draft and never touches an approved version; the build spec changes only when you approve
   another version.
5. **Verification is grounded.** Map ids are only used to *align* plan and code. Evidence per
   planned item: files the plan names exist and were changed in git since the baseline; the files
   of the regenerated node changed; its arrows are cited in code (`evidence`); tests, where the
   project has them. Four results: **Verified** (code evidence, not only a node), **Missing** (no
   trace), **Unexpected** (changed in git or present in the map but not in the plan), **Needs
   review** (partial or diagram-only evidence). A node that exists only in a regenerated diagram is
   never Verified.
6. **The proposal endpoint is locked down.** `propose_plan` is an MCP tool served by Flightdeck at
   `/mcp`. Each Discuss turn gets a fresh random token (in the `--mcp-config` header it passes to
   `claude`), bound to that run, chat and project, valid only while that run is active and in
   Discuss. Requests with an `Origin` header (any browser page) are refused; the gateway listener
   refuses `/mcp` like `/hook`; every body is size-limited and checked against the schema. The tool
   writes only a plan version row: it can't touch files, and Build turns don't get it.

### Phases (each tested before the next)
1. **Plan data model**: schema, validation against the current maps, `applyPlan` (shared, pure),
   insert-only versions, baselines and staleness. Unit tests.
2. **Proposal and overlay**: spike `--mcp-config` (HTTP) with Claude Code first, then the `/mcp`
   endpoint and token, hook allowance, the Discuss prompt, a feed item per version, and the map
   pane's Current / Plan switch with All / Changes only.
3. **Approval and Build**: Approve / Drop, revalidate, the approved version in the Build prompt,
   `runs.plan_version_id`.
4. **Verification**: regenerate the plan's views with its ids as hints, gather git and file
   evidence, show the four states in the chat and on the plan view.

### As built (2026-10-11)
All four phases, each tested before the next (62 unit tests; live runs in Playground, chat 8).
- **Data**: `plans` (one per chat), `plan_versions` (insert-only: SQLite triggers refuse updates to
  content, un-approving and deletes), `plan_checks`, `runs.plan_version_id`. Pure core in
  `src/shared/plan.ts` (validate, overlay, files, text for Build); git and storage in
  `src/server/plans.ts`; checks in `src/server/verify.ts`; the MCP endpoint in `src/server/mcp.ts`.
- **Baselines**: per repository, HEAD plus a git content hash of every modified/untracked file, so
  uncommitted work at proposal time doesn't read as change later, and committing it unchanged
  doesn't either. `.flightdeck/` is ignored. Freshness: *stale* only when changed files fall
  inside what the plan adds, changes or removes; a neighbour changing is *elsewhere*.
- **Spike findings** (Claude Code 2.1.296): `--mcp-config` with an `http` server works in `-p`
  runs, and `${FLIGHTDECK_MCP_TOKEN}` in its headers is expanded from the environment, so the
  token never appears on the command line. The PreToolUse hook sees `mcp__flightdeck__…` calls.
  MCP tools are deferred: the agent loads them through `ToolSearch`, which the hook now allows
  without a card (it only loads descriptions). A Build turn resuming a session that had the MCP
  server in Discuss works without it.
- **A resumed session keeps its FIRST turn's system prompt**: `--append-system-prompt` on later
  turns is ignored. So Build turns never learned they were in Build (the cause of the
  "it thinks we're in Discuss" report — the earlier prompt-only fix didn't reach the agent). Each
  turn's message now starts with that turn's Flightdeck instructions (mode, and for Build the
  approved plan); the feed shows only what the user typed. Verified: a resumed Build turn reports
  Build mode and the approved version, and stopped on the plan's open questions.
- **`get_maps`**: a second MCP tool returning the current maps compactly, so the agent doesn't need
  shell reads (each an approval card) to learn node ids.
- **Checks** regenerate only the views the approved version changes, one at a time, with id hints
  (the previous map's ids, then the plan's); the generator is told the ids are names only. Test
  runs are read from the Build turns that recorded that version. Verified live with nothing
  built: all five planned items came back Missing, with evidence, and the hints didn't make the
  generator draw them.
- **Not yet seen live**: a check after a real Build (Verified and Unexpected on real changes). The
  unit tests cover those paths.

### Open questions
- If Build finds the plan doesn't fit reality: the agent stops and says so (leaning), rather than
  amending the plan itself.
- Done plans stay in the chat as history; a decision record in the repo is not in v1.

## 11. Requirements workspace (started 2026-10-11)

A persistent PRD — overview, global business rules with stable ids (`BR-001`…), feature specs with
acceptance criteria — kept as Markdown **in the repository** (`docs/requirements/PRD.md`,
`docs/requirements/features/*.md`; in a multi-repo folder, inside the maps repo), next to a chat that
can discuss it. `CLAUDE.md` stays the engineering instructions; the PRD says what the software must do.

### Decisions
- **Approval lives in Flightdeck's database, not in the file** (same reason as the rules, §4: the
  agent can edit anything in the repo). An approval is an insert-only row: document, content hash,
  the approved text. A `status:` line in the file is informational. If the file's hash differs
  from the approved one, the UI says "changed since approval" and Build keeps using the approved text.
  Approving never commits.
- **Only the UI writes `docs/requirements/`**: the hook refuses agent edits there in both modes. The
  agent proposes edits through an MCP tool (like `propose_plan`); Accept writes the file. Every save
  carries the hash it started from, and a mismatch (an IDE edit meanwhile) is refused as a conflict.
- **Approved ids are never renumbered**: a new id is one above the highest in use; an approved rule
  that no longer applies stays, marked retired. Until its first approval a draft's ids can change
  freely (changed 2026-10-11: protecting every saved id made a first draft — especially one written
  from a conversation or the code — accumulate retired rules before anyone had approved anything).
- **Context is a reference** (`{doc, id, revision}`), resolved server-side, as map nodes are.
- Plans stay a *layer* on the map tabs (§10 rule 3), not a tab of their own.

### Phases
1. Audit — done.
2. **Workspace shell — BUILT 2026-10-11.** The chat screen is chat (left) + workspace (right) with
   tabs PRD · Architecture · Data model · Flows · Code, behind a divider (drag, arrow keys, double-click
   resets; kept in `fd.split`). Each chat keeps its draft (also across reloads), attached context,
   workspace tab and open file when you switch away (`src/web/workspace.ts`). The chat's name is a
   Chats menu (switch / new) on every screen size. Under 1000px one panel at a time; under 700px the
   sidebar steps aside while a chat is open (the Chats menu brings it back). Files the agent touched
   open in the Code tab instead of a dialog. The PRD tab shows `docs/requirements/PRD.md` read-only.
3. **Document lifecycle — BUILT 2026-10-11.** `src/shared/requirements.ts` reads a document (outline;
   ids where they start a heading or list item; retired by `(retired)` or `~~id~~`; code blocks and
   HTML comments skipped) and checks a revision: no duplicate ids, none used by another document, none
   that the file or an approved version had may vanish. `src/server/requirements.ts` reads, saves and
   approves: only `PRD.md` and `features/<slug>.md`, every step checked with `lstat` (a symlink
   anywhere is refused), written to a temp file and renamed. A save carries the hash it started from;
   a mismatch is a 409 with the current text, and the UI offers *load theirs* or *save mine over it*.
   Approvals go to `requirement_approvals` (insert-only: triggers refuse updates and deletes) with the
   approved text, its hash and ids; state per document is draft / approved vN / changed since vN /
   file missing. The PRD tab lists the documents and the open one's outline, renders it (comments
   hidden), edits it as plain Markdown (⌘S saves; *+ Rule id* / *+ Criterion id* insert the next free
   id), approves exactly the text shown, reads earlier versions read-only, and polls every 5 s for
   changes made outside. An unsaved edit survives switching tabs or chats. The hook refuses the agent's
   edit tools anywhere under the requirements folder, in both modes (`decidedBy: requirements`;
   compared case-insensitively and through symlinks) — verified live: a Build turn's `Edit` of
   `PRD.md` was refused and the file was untouched. Shell writes aren't blocked there; the hash check
   shows them as *changed since vN*, and Build (phase 5) is to use the approved text. Nothing commits.
4. **Contextual conversations — BUILT 2026-10-11.** In the PRD tab every heading and every id'd list
   item has a quiet *+ chat* (on hover or focus) that attaches it to the chat's next message, beside map
   nodes in the same chip row. The message carries only `{doc, ref}` (an id, or `§Heading` for a
   section); the server reads that part from the file and puts it above the message with the revision
   it is (*approved v2*, *draft: changed since approved v2*, *draft, never approved*), capped at 8 KB;
   a ref that's gone is refused. Discuss turns get two more MCP tools: `get_requirements` (documents,
   state, ids) and `propose_requirements_edit` (Edit-style `old_string`/`new_string` replacements, or a
   whole text for a new document). A proposal is checked like a save (ids, paths) and stored in
   `requirement_proposals` with the hash it was made against; it writes nothing. The chat shows a card
   with *Review*; the PRD tab lists open proposals and shows each as a line diff with Accept / Reject.
   Accept goes through the same checked save, so a document that moved on since is refused ("ask for
   a new proposal"); the result is a draft revision — approval stays a separate click. A newer
   proposal from the same chat for the same document supersedes the open one, and each Discuss turn is
   told what became of its recent proposals. Verified live (Haiku, Discuss): with BR-001 attached the
   agent quoted it without reading the file, proposed the change through the tool, and Accept wrote it
   as *changed since v2*.
5. **Build and links — BUILT 2026-10-11.** In Build, an attached requirement resolves against its
   document's latest **approved** version, not the file; a part that exists only in a draft (or a
   document never approved) refuses the send with the reason. Requirement ids named in the message or
   in the chat's approved plan are added the same way (shown as *named:* in the history); ids that
   exist only in drafts are listed to the agent as not approved. Each Build turn is told which
   documents have unapproved drafts ("not part of the spec"), to stop rather than reinterpret, and that
   a requirement is met by code and tests, not by a map. `runs.requirements` records `{doc, ref,
   version}` for every requirement a Build turn was given. Discuss is asked to name requirement ids in
   plans, so approved plans carry them into Build. Links in documents: a repository path opens in the
   Code tab (`#L12` at a line; `./`, `../` relative to the document), `map:<view>/<node-id>` opens the
   map, drills to the node and selects it. Verified live (Haiku, Build): with BR-001 attached and
   BR-002/BR-003 in the text, the agent quoted v2's wording (not the newer draft), BR-002 came in as
   named, BR-003 was reported as unapproved, and the run recorded both v2 revisions.

### Requirements first for new projects (2026-10-11)
*New project* asks what to start with. **Requirements** (the default) creates the repository and opens
a Discuss chat titled "Requirements" with the PRD tab beside it; if a description was given, its first
turn asks the questions it needs and, when told to, proposes `PRD.md` from the conversation, with what
isn't decided under Open questions — no scaffold, no code. A stack can be named as the intention or left
for later. **Scaffold** is the earlier behaviour (a Build chat that generates the stack). Discuss turns
are told to write down only what the user decided. Verified live (Haiku): the kickoff asked about users,
order contents, limits, payment and changes; after the answers it proposed a PRD with BR-001…008 matching
them and the undecided points (stock limits, accounts, slots) as open questions.

### Not in v1
Automatic requirement ↔ code traceability; a diff of the file against its approved version; editing
a proposal before accepting it; attached context surviving a reload; requirement ids in the URL.
