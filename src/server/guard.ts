// What stands in for a login on the local listener. Flightdeck's API starts Claude turns, so a web
// page open in the browser must not be able to drive it:
//   - Host must be loopback: blocks DNS rebinding (a hostile name resolved to 127.0.0.1).
//   - A request that changes anything must come from Flightdeck's own page (Origin), or from a
//     non-browser client such as the `claude` hook (no Origin), and may only carry JSON, which a
//     cross-site form can't send.
// Returns why a request is refused, or null to let it through.
import { config } from './config.ts';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
// Names that point at this machine: *.localhost always does; others (an /etc/hosts entry such as the
// port-80 address) come from FLIGHTDECK_HOSTNAMES and FLIGHTDECK_BARE_HOST (config.hostnames).
const isLocalName = (h: string) => LOOPBACK.has(h) || h.endsWith('.localhost') || config.hostnames.has(h);

export function refuseLocal(req: Request): string | null {
  const host = (req.headers.get('host') ?? '').toLowerCase().replace(/:\d+$/, '');
  if (!isLocalName(host)) return 'Flightdeck only answers on this machine\'s own names';
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return null;

  const origin = req.headers.get('origin');
  if (origin !== null) {
    let ok = false;
    try { ok = isLocalName(new URL(origin).hostname.toLowerCase().replace(/^::1$/, '[::1]')); } catch { /* malformed */ }
    if (!ok) return 'cross-site request refused';
  }
  const type = (req.headers.get('content-type') ?? '').toLowerCase();
  if (type !== '' && !type.startsWith('application/json')) return 'only JSON requests are accepted';
  return null;
}
