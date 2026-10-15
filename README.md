# Flightdeck

An IDE for directing code instead of typing it. You **see** each project as diagrams generated
from its code, and **steer** it by chatting with Claude Code. The agent does the work; you watch
where in the system it happens and approve what it wants to run.

It is a **personal, single-user tool**: it runs on your own machine, loopback only, and drives the
**unmodified `claude` CLI with your own Claude subscription login** — never API keys (see
[PLAN.md §5](PLAN.md) for the terms this relies on). Built for macOS as Flightdeck.app; the server
itself is plain Node and also runs from a checkout on Linux.

**Status (2026-10-14):** chat, maps, plans and the requirements workspace built and in daily use by
its author. Expect rough edges; it is shared as-is.

## What you need
- **macOS** for Flightdeck.app (the Xcode command line tools provide `swiftc`: `xcode-select --install`).
  Any OS with Node for the server alone.
- **Node 22+** and **git**.
- **Claude Code** installed and logged in to a Claude subscription: run `claude` once and `/login`.
  Flightdeck finds it at `~/.local/bin/claude` or on `PATH` (`CLAUDE_BIN` overrides).
- Your projects as git repositories under one folder, `~/dev` by default (`FLIGHTDECK_BROWSE_ROOT`).

## Install (Mac)
```sh
git clone https://github.com/VLO-Labs/flightdeck.git && cd flightdeck
cp .env.example .env      # optional: port, host name, project folders, default model …
scripts/mac/install.sh
```
Opening **Flightdeck.app** starts the server and opens the browser at http://flightdeck.localhost:8100;
quitting it stops the server. The Dock icon reopens the page.

- **Update:** `git pull`, then `scripts/mac/install.sh` again. It copies this repo to
  `~/Library/Application Support/Flightdeck/app`, runs `npm ci` and the build there, and (re)builds
  `/Applications/Flightdeck.app`. It refuses while a chat turn or map refresh is running, and quits
  and reopens the app if it was open. The app runs that copy, never the checkout, so a chat editing
  this repo can't change the running server.
- **Data:** `~/Library/Application Support/Flightdeck/data` (SQLite + chat feeds); untouched by
  updates, new tables and columns are added on start. **Log:** `~/Library/Logs/Flightdeck.log`.
- **Stop:** quit the app, or `scripts/mac/stop.sh`.
- **Port-less address (optional):** set `FLIGHTDECK_BARE_HOST=flightdeck.test` (any name) in `.env`,
  run `sudo scripts/mac/port80.sh` once, then `scripts/mac/install.sh` again. The name gets its own
  loopback IP and port 80 forwards to the server. Loopback only either way: nothing on the network
  can reach Flightdeck.

## Configure
Everything is set through environment variables, read from a `.env` file next to the code (the
install script copies the repo's `.env` beside the app) or from the environment, which wins.
[`.env.example`](.env.example) lists them all with their defaults; the ones most people touch:

| Variable | Default | What |
|---|---|---|
| `FLIGHTDECK_PORT`, `FLIGHTDECK_HOST_NAME` | `8100`, `flightdeck.localhost` | The address the page opens at |
| `FLIGHTDECK_BROWSE_ROOT` | `~/dev` | Projects must live inside this folder |
| `FLIGHTDECK_PROJECTS_DIR` | the browse root | Where *+ New project* creates projects |
| `FLIGHTDECK_MODEL` | `claude-opus-5-5` | Model new projects start with (`haiku` to spare the plan) |
| `CLAUDE_BIN` | `~/.local/bin/claude` or `claude` on PATH | The Claude Code binary |
| `FLIGHTDECK_DATA` | app data folder / `./data` | Database and chat feeds |

Change one of the address variables or `CLAUDE_BIN` and re-run `scripts/mac/install.sh`; the app
bakes those in. The rest take effect on the next start.

## Run from a checkout
```sh
npm ci && npx vite build
FLIGHTDECK_DATA=./data FLIGHTDECK_PORT=8199 npm start
```
A separate port and data folder, so it never touches the installed app's. Checks: `npm test`,
`npm run typecheck`. Contributors: see [`CLAUDE.md`](CLAUDE.md) for how changes go live.

## How it stays yours
- **Loopback only.** The server binds 127.0.0.1 and refuses requests whose `Host` isn't a name of
  this machine (blocks DNS rebinding) or whose `Origin` is another site; state changes must be JSON.
  No login, because nothing else can reach it.
- **Approval cards.** Claude Code's tool calls go through an HTTP hook that holds them until you
  click Allow or Deny, under per-project rules you set. Discuss chats can't change files at all;
  one Build chat at a time holds a project's edit lock.
- **Subscription, not keys.** `ANTHROPIC_API_KEY` is stripped from the agent's environment, and a
  run aborts if the CLI reports any auth other than the subscription login.

| Read | For |
|------|-----|
| [`PLAN.md`](PLAN.md) | What it is, the decisions and why, how the chat works, the build phases |

## Requirements (PRD)
Each project can keep a PRD and feature specs **in its own repository**, as plain Markdown that works
anywhere (VS Code, GitHub, Claude Code):

```
docs/requirements/PRD.md               overview, users, scope, business rules (BR-001 …)
docs/requirements/features/<name>.md   one per feature: scenarios, edge cases, acceptance criteria (AC-001 …)
```
In a multi-repo folder they live in the repository that keeps the maps. `CLAUDE.md` stays the
engineering instructions; the PRD says what the software must do.

- **Start one:** for a new project, *+ New project* → **Start with: Requirements** (the default): it
  creates the repository and opens a Discuss chat — no code — that asks what you need and proposes the
  PRD from your conversation, leaving what you haven't decided under Open questions; scaffold later in
  Build. For any project, a Discuss chat can be asked to write or revise it, or use the **PRD** tab →
  *Start the PRD* (a template with headings and guidance, no rules) and edit it yourself. *+ Feature
  spec* adds a spec. Files written by hand show up too.
- **Ids** start a heading or list item (`### BR-001 · …`, `- **AC-001** …`). A draft's ids can change
  until they are approved; after that they never change and are never reused, and a rule that no
  longer applies is marked `(retired)`. Saves that break this are refused.
- **Approve** freezes exactly the text you see as vN (kept in Flightdeck's database); later edits are
  a draft until approved. Nothing is committed for you — commit the files like any others.
- **In chat:** *+ chat* on any rule or section attaches it to your message. In Discuss the agent can
  propose edits, which you accept or reject as a diff; it can't write the files. In Build, attached
  requirements, and any ids the message or the approved plan names, go as their **approved** text,
  and each run records which versions it used.
- **Links** in the documents: `[name](src/file.ts#L10)` opens the file, `[name](map:architecture/<node-id>)`
  shows the node on its map.

## License
[MIT](LICENSE).

## History
- **2026-10-10** — idea scoped in a Claude Code session: IDE replacement for an
  architecture-first / vibe-coding workflow. Named Flightdeck. Phase 1 = projects, diagrams,
  chats. Docs-verified the headless CLI mechanics and the subscription terms the plan relies on.
- **2026-10-10** — Step 0 spike run on the box: hook-held approvals, SIGINT stop, resume and the
  subscription tripwire all confirmed. Corrected the plan: a timed-out approval falls back to
  Claude Code's normal rules (read-only runs, writes refused), not a blanket deny.
- **2026-10-10** — TypeScript locked; per-project approval rules designed. Phase 1a built:
  projects, chats on headless `claude -p`, approval cards (http PreToolUse hook), per-project
  rules, edit lock, stop, replay, model per chat (default Opus 5.5). Verified end to end on the
  box: Opus 5.5 on the subscription (`apiKeySource: none`), card → allow + "always allow" rule,
  deny with reason, edit lock refusing a second chat's writes, stop with a card open.
- **2026-10-10** — Discuss / Build modes per chat, with a model per mode (project defaults Opus
  5.5 for both, chat overrides). Verified: Discuss refused the edit and proposed it; switching to
  Build in the same session made it from "go ahead". Confirmed chats share Claude Code's
  per-project memory.
- **2026-10-10** — Phase 1b built: maps (architecture / data model / flows) generated from code by
  a read-only agent with structured output, validated, stored in `.flightdeck/`, drawn with React
  Flow + ELK, drill-down, change detection, read-only file viewer. Flightdeck's own maps are
  committed in `.flightdeck/`. Hardened the rules engine on the way: output redirection is never
  covered by an allow rule.
- **2026-10-10** — Phase 1c built: map pane in chats, nodes as message context (resolved
  server-side), live read/edit highlighting, "Discuss in a new chat". First look at the real UI in
  a browser found and fixed: double-click zoomed instead of opening a node, a double-click also
  toggled context twice, the canvas fitted to the previous level, and a crowded chat header.
  **Phase 1 is complete.**
- **2026-10-11** — Permanent: systemd service, tunnel route and SSO via the shared gateway
  (`flightdeck.vlolabsdev.com`). The gateway reaches the native listener over docker0 with a
  secret header; UFW needed an allow from the docker subnets (Docker-published services never
  hit UFW, a native one does).
- **2026-10-11** — Requirements workspace (PLAN.md §11): chat beside a tabbed workspace (PRD, maps,
  code); PRD and feature specs as Markdown in the repo with stable ids, approved revisions kept by
  Flightdeck, requirements attached to messages, agent-proposed edits reviewed as diffs, Build given
  the approved text.
