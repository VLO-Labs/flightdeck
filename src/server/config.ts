import { homedir } from 'node:os';
import { join } from 'node:path';

const num = (v: string | undefined, d: number) => (v ? Number(v) : d);

export const config = {
  host: '127.0.0.1', // loopback only — never public; the tunnel + SSO is the only way in
  port: num(process.env.FLIGHTDECK_PORT, 8100),
  forwardPort: process.env.FLIGHTDECK_FORWARD_PORT ? Number(process.env.FLIGHTDECK_FORWARD_PORT) : undefined,
  dataDir: process.env.FLIGHTDECK_DATA ?? join(process.cwd(), 'data'),
  // "Add existing" can browse folders only inside this tree (symlinks resolved, so none lead out).
  browseRoot: process.env.FLIGHTDECK_BROWSE_ROOT ?? join(homedir(), 'dev'),
  claudeBin: process.env.CLAUDE_BIN ?? join(homedir(), '.local/bin/claude'),
  // The model a new chat starts with; each chat can change it. FLIGHTDECK_MODEL overrides the
  // default (e.g. `haiku` while testing, to spare the plan).
  defaultModel: process.env.FLIGHTDECK_MODEL ?? 'claude-opus-5-5',
  // How long an approval card may stay open. The hook's own timeout is set a minute above this,
  // so Flightdeck always answers first (with a deny) rather than letting the hook time out.
  approvalTimeoutS: num(process.env.FLIGHTDECK_APPROVAL_TIMEOUT_S, 30 * 60),
  // Second listener for the SSO gateway (nginx in Docker reaches the host at the docker0 address,
  // 172.17.0.1). Every request on it must carry the gateway's secret header, because any container
  // on the box can reach that address — and Flightdeck's API can run code. Unset = no listener.
  gatewayHost: process.env.FLIGHTDECK_GATEWAY_HOST,
  gatewaySecret: process.env.FLIGHTDECK_GATEWAY_SECRET ?? '',
};
