// Stacks offered when creating a new project. Flightdeck doesn't scaffold anything itself: it opens
// a Build chat whose first message is the stack's instruction, so Claude runs the official
// generator and every command goes through the project's approval rules like any other turn.
export const STACKS = [
  {
    id: 'ts-hono-react',
    label: 'TypeScript: Hono + React/Vite',
    instruction:
      'TypeScript end to end, ESM, Node 22. Server: Hono on @hono/node-server under src/server, run with tsx. ' +
      'Shared Zod contracts under src/shared. Web: a Vite + React SPA under src/web, built to dist/ and served by the server. ' +
      'SQLite through better-sqlite3 + drizzle-orm. Tests with node:test. A /health endpoint.',
  },
  {
    id: 'laravel-filament',
    label: 'Laravel + Filament',
    instruction:
      'Laravel (latest) via `composer create-project laravel/laravel .`, with a Filament (latest) admin panel. ' +
      'PostgreSQL in .env.example (placeholders only, no real credentials). Pest for tests. ' +
      'Check that php and composer are available first; if either is missing, say so and stop.',
  },
  {
    id: 'go-service',
    label: 'Go service',
    instruction:
      'A Go module (latest stable Go): cmd/<name>/main.go plus internal/ packages, net/http with the standard ' +
      'router, slog logging, config from environment variables, a /health endpoint, go test, and a multi-stage ' +
      'Dockerfile. Check that go is available first; if it is missing, say so and stop.',
  },
  {
    id: 'astro',
    label: 'Static site: Astro',
    instruction:
      'An Astro static site (create-astro, minimal template, TypeScript strict) with the MDX integration, ' +
      'static output to dist/ for Cloudflare Pages.',
  },
  {
    id: 'next-export',
    label: 'Static site: Next.js export',
    instruction:
      "Next.js with the App Router and TypeScript, `output: 'export'` (fully static, to out/) for Cloudflare Pages.",
  },
  {
    id: 'expo',
    label: 'Mobile: Expo (React Native)',
    instruction:
      'An Expo app (latest SDK) with expo-router and TypeScript, using pnpm. Make sure it typechecks; ' +
      "don't try to launch a simulator.",
  },
] as const;

export type StackId = (typeof STACKS)[number]['id'];
export const STACK_IDS = STACKS.map(s => s.id) as [StackId, ...StackId[]];

// The first message of a project started from its requirements: a Discuss turn that asks before it
// writes, and proposes the PRD (PLAN.md §11) — nothing gets built until the user switches to Build.
export function requirementsKickoff(name: string, description: string, stackId?: StackId): string {
  const stack = stackId ? STACKS.find(s => s.id === stackId) : undefined;
  return [
    `This is a brand-new, empty repository for a project called "${name}". Nothing is built yet: we're ` +
      'defining what it must do before deciding how. Here is what I have in mind:',
    description.trim(),
    stack ? `The stack I intend to use, later: ${stack.label}.` : '',
    'Ask me what you need to know — who uses it, the goals, what is in and out of scope, the rules that must ' +
      'always hold — a few questions at a time. When we have settled enough, propose docs/requirements/PRD.md ' +
      'with the requirements tool (the whole text, as a new document), with ids for the business rules; put ' +
      'anything I haven\'t decided under Open questions instead of inventing it. Feature specs follow the same way, ' +
      'one per feature, once the PRD is approved. Don\'t scaffold or write code yet.',
  ].filter(Boolean).join('\n\n');
}

export function scaffoldPrompt(stackId: StackId, name: string, description?: string): string {
  const stack = STACKS.find(s => s.id === stackId)!;
  return [
    `This is a brand-new, empty git repository for a project called "${name}". Scaffold it as: ${stack.label}.`,
    stack.instruction,
    description?.trim() ? `What the project is for: ${description.trim()}` : '',
    'Use the official generator where one exists, non-interactively, directly in this folder (not a subfolder). ' +
      'Then add a README.md (what it is, the stack, how to run it), a CLAUDE.md with the conventions you set up, ' +
      'and a .gitignore. Make sure it installs and builds or typechecks. ' +
      "Don't add a git remote, push, or deploy. Commit the scaffold as one commit, then summarize what you created and how to run it.",
  ].filter(Boolean).join('\n\n');
}
