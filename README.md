# Flightdeck

An IDE for directing code instead of typing it. You **see** each project as diagrams generated
from its code, and **steer** it by chatting with Claude Code. The agent does the work; you watch
where in the system it happens and approve what it wants to run.

Single user (Hayk), self-hosted on vlolabsdev, driving the **unmodified `claude` CLI on the
Claude subscription** — never API tokens.

**Status (2026-10-10):** Phase 1a (chat) built and tested end to end on the box. Private repo
`VLO-Labs/flightdeck`.

## Run it
On the box (Node 22): `npm ci && npx vite build && FLIGHTDECK_DATA=/data/flightdeck npm start`
→ `127.0.0.1:8100`, loopback only. From the Mac: `ssh -L 8100:127.0.0.1:8100 vlolabs@vlolabsdev`,
then open http://localhost:8100. No systemd unit, tunnel route or SSO yet — a dev instance dies
with the box. Tests: `npm test`.

| Read | For |
|------|-----|
| [`PLAN.md`](PLAN.md) | What it is, the decisions and why, how the chat works, the build phases |

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
