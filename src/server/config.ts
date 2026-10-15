// Settings, all from the environment (see .env.example for the full list). A `.env` file in the
// working directory — or the one FLIGHTDECK_ENV_FILE names — is loaded first; variables already in
// the environment win over it, so `FLIGHTDECK_PORT=8199 npm start` still works with a .env present.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const envFile = process.env.FLIGHTDECK_ENV_FILE ?? join(process.cwd(), '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const num = (v: string | undefined, d: number) => (v ? Number(v) : d);
// `~` at the start of a path means the home folder, as in a shell.
const path = (v: string | undefined) => (v ? resolve(v.replace(/^~(?=$|\/)/, homedir())) : undefined);
const list = (v: string | undefined) => (v ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// The Claude Code binary: CLAUDE_BIN, else the native installer's location, else whatever `claude`
// is on PATH.
const defaultClaude = () => {
  const native = join(homedir(), '.local/bin/claude');
  return existsSync(native) ? native : 'claude';
};

const browseRoot = path(process.env.FLIGHTDECK_BROWSE_ROOT) ?? join(homedir(), 'dev');
// A name that reaches this machine without a port, when scripts/mac/port80.sh has set one up.
const bareHost = (process.env.FLIGHTDECK_BARE_HOST ?? '').trim().toLowerCase();

export const config = {
  host: '127.0.0.1', // loopback only — never public
  port: num(process.env.FLIGHTDECK_PORT, 8100),
  // Second loopback port, the target of the Mac's port-80 forwarding (scripts/mac/port80.sh).
  forwardPort: process.env.FLIGHTDECK_FORWARD_PORT ? Number(process.env.FLIGHTDECK_FORWARD_PORT) : undefined,
  dataDir: path(process.env.FLIGHTDECK_DATA) ?? join(process.cwd(), 'data'),
  // Projects must live inside this tree; "Add existing" can browse only here (symlinks resolved,
  // so none lead out).
  browseRoot,
  // Where "+ New project" proposes to create a project; inside browseRoot.
  newProjectsDir: path(process.env.FLIGHTDECK_PROJECTS_DIR) ?? browseRoot,
  // Host names, besides localhost / 127.0.0.1 / *.localhost, that point at this machine (e.g. an
  // /etc/hosts entry). Requests under any other name are refused — see guard.ts.
  hostnames: new Set([...list(process.env.FLIGHTDECK_HOSTNAMES), ...(bareHost ? [bareHost] : [])]),
  claudeBin: process.env.CLAUDE_BIN ?? defaultClaude(),
  // The model a new project starts with; each project and chat can change it. FLIGHTDECK_MODEL
  // overrides the default (e.g. `haiku` while testing, to spare the plan).
  defaultModel: process.env.FLIGHTDECK_MODEL ?? 'claude-opus-5-5',
  // How long an approval card may stay open. The hook's own timeout is set a minute above this,
  // so Flightdeck always answers first (with a deny) rather than letting the hook time out.
  approvalTimeoutS: num(process.env.FLIGHTDECK_APPROVAL_TIMEOUT_S, 30 * 60),
  // Optional second listener for a reverse proxy / SSO gateway on another interface. Every request
  // on it must carry the secret in an `x-flightdeck-gateway` header, because Flightdeck's API can
  // run code. Unset = no listener.
  gatewayHost: process.env.FLIGHTDECK_GATEWAY_HOST,
  gatewaySecret: process.env.FLIGHTDECK_GATEWAY_SECRET ?? '',
};
