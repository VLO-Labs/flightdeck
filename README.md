# Flightdeck

An IDE for directing code instead of typing it. You **see** each project as diagrams generated
from its code, and **steer** it by chatting with Claude Code. The agent does the work; you watch
where in the system it happens and approve what it wants to run.

Single user (Hayk), running **locally on the Mac as Flightdeck.app**, driving the **unmodified
`claude` CLI on the Claude subscription** — never API tokens.

**Status (2026-10-11):** chat, maps, plans and the requirements workspace built and in daily use.
Private repo `VLO-Labs/flightdeck`.

## Run it
**The app (how it runs):** Flightdeck.app on the Mac. Opening it starts the server and opens the
browser at http://flightdeck.localhost:8100; quitting it stops the server.

- **Install or update:** `scripts/mac/install.sh` — run it after committing changes. It copies this
  repo to `~/Library/Application Support/Flightdeck/app`, runs `npm ci` and the build there, and
  (re)builds `/Applications/Flightdeck.app`. It refuses while a chat turn or map refresh is running,
  and quits and reopens the app if it was open. The app runs that copy, never this checkout, so a chat
  editing this repo can't change the running server — and pushing to GitHub doesn't update it.
- **Data:** `~/Library/Application Support/Flightdeck/data` (SQLite + chat feeds); untouched by
  updates, and new tables/columns are added on start. **Log:** `~/Library/Logs/Flightdeck.log`.
- **Stop:** quit the app, or `scripts/mac/stop.sh`.
- **Port-less address (optional, once):** `sudo scripts/mac/port80.sh` gives http://flightdeck.vlolabs
  (its own loopback IP, port 80 → 8101). Loopback only either way: nothing on the network can reach it.

**Dev (from this checkout):** `npm ci && npx vite build && FLIGHTDECK_DATA=./data FLIGHTDECK_PORT=8199 npm start`
— a separate port and data folder, so it never touches the app's. Tests: `npm test`; types: `npm run typecheck`.

The earlier vlolabsdev deployment (systemd service, `make flightdeck`, Cloudflare Tunnel + SSO
gateway) is **not used**; the gateway listener code (`FLIGHTDECK_GATEWAY_HOST`) remains but is off.

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

- **Start one:** open a chat → workspace **PRD** tab → *Start the PRD* (a template with headings and
  guidance, no rules), edit, Save. *+ Feature spec* adds a spec. Or write the files by hand and they
  show up.
- **Ids** start a heading or list item (`### BR-001 · …`, `- **AC-001** …`), never change and are
  never reused; a rule that no longer applies is marked `(retired)`. Saves that break this are refused.
- **Approve** freezes exactly the text you see as vN (kept in Flightdeck's database); later edits are
  a draft until approved. Nothing is committed for you — commit the files like any others.
- **In chat:** *+ chat* on any rule or section attaches it to your message. In Discuss the agent can
  propose edits, which you accept or reject as a diff; it can't write the files. In Build, attached
  requirements, and any ids the message or the approved plan names, go as their **approved** text,
  and each run records which versions it used.
- **Links** in the documents: `[name](src/file.ts#L10)` opens the file, `[name](map:architecture/<node-id>)`
  shows the node on its map.

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
