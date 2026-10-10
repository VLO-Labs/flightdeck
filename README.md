# Flightdeck

An IDE for directing code instead of typing it. You **see** each project as diagrams generated
from its code, and **steer** it by chatting with Claude Code. The agent does the work; you watch
where in the system it happens and approve what it wants to run.

Single user (Hayk), self-hosted on vlolabsdev, driving the **unmodified `claude` CLI on the
Claude subscription** — never API tokens.

**Status (2026-10-10):** planned, not built. Private repo `VLO-Labs/flightdeck`.

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
