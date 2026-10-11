// Processes running in a project's folder: dev servers, watchers, queues — whether the agent started
// them (a `nohup … &` outlives its turn and Claude Code stops tracking it) or you did in a terminal.
// Found by working directory (lsof), grouped into trees (ps), with the TCP ports each tree listens on.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProcessGroup } from '../shared/contracts.ts';

const run = promisify(execFile);

export type Proc = { pid: number; ppid: number; secs: number; command: string };

// Interactive shells and Claude Code sessions (and the `caffeinate` it runs) sit in project folders
// too; they aren't "running" things. Their children (a server started from a terminal) still show,
// as trees of their own.
const NOT_A_TASK = /^(-?(zsh|bash|sh|fish|login)|claude|caffeinate|tmux.*|screen)$/;

// A command that has run for less than this is a one-off (a test run, a grep), not something left running.
const MIN_SECS = 5;

// `ps -o etime`: [[dd-]hh:]mm:ss
export function parseEtime(s: string): number {
  const [days, rest = ''] = s.includes('-') ? s.split('-') : ['0', s];
  return rest.split(':').map(Number).reduce((acc, n) => acc * 60 + n, 0) + Number(days) * 86400;
}

export function parsePs(out: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of out.split('\n')) {
    const [, pid, ppid, etime, command] = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/) ?? [];
    if (pid && ppid && etime && command) procs.push({ pid: +pid, ppid: +ppid, secs: parseEtime(etime), command: command.trim() });
  }
  return procs;
}

// `lsof -F pn`: a `p<pid>` line, then `n<name>` lines for that process.
export function parseLsof(out: string): Map<number, string[]> {
  const names = new Map<number, string[]>();
  let pid = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) names.set(pid, [...(names.get(pid) ?? []), line.slice(1)]);
  }
  return names;
}

const exe = (command: string) => command.split(/\s+/)[0]?.split('/').pop() ?? '';

// Absolute paths shown by their last part: `php /opt/homebrew/bin/composer dev` → `php composer dev`.
export const shortCommand = (command: string) =>
  command.split(/\s+/).map(t => (t.startsWith('/') ? t.split('/').pop() : t)).join(' ').slice(0, 120);

// One group per tree of processes in the project. A tree's root is a process whose parent isn't in the
// project; descendants of `ownPid` (Flightdeck and the turns it runs) are left out.
export function buildGroups(
  procs: Proc[], cwds: Map<number, string[]>, listens: Map<number, string[]>, roots: string[], ownPid: number,
): ProcessGroup[] {
  const byPid = new Map(procs.map(p => [p.pid, p]));
  const children = new Map<number, number[]>();
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);

  const ours = new Set<number>();
  for (const stack = [ownPid]; stack.length;) {
    const pid = stack.pop()!;
    ours.add(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  const inProject = (pid: number) =>
    (cwds.get(pid) ?? []).some(cwd => roots.some(r => cwd === r || cwd.startsWith(r + '/')));
  const member = new Set(procs.filter(p => inProject(p.pid) && !ours.has(p.pid) && !NOT_A_TASK.test(exe(p.command))).map(p => p.pid));

  const groups: ProcessGroup[] = [];
  for (const pid of member) {
    const root = byPid.get(pid)!;
    if (member.has(root.ppid) || root.secs < MIN_SECS) continue; // not a root, or a one-off
    const tree: number[] = [];
    for (const stack = [pid]; stack.length;) {
      const p = stack.pop()!;
      tree.push(p);
      stack.push(...(children.get(p) ?? []));
    }
    const ports = [...new Set(tree.flatMap(p => listens.get(p) ?? []).map(n => n.replace(/^.*:/, '')))]
      .map(Number).filter(Boolean).sort((a, b) => a - b);
    groups.push({ pid, command: shortCommand(root.command), secs: root.secs, ports, pids: tree });
  }
  // Servers first, then the longest-running.
  return groups.sort((a, b) => Number(b.ports.length > 0) - Number(a.ports.length > 0) || b.secs - a.secs);
}

export async function projectProcesses(roots: string[]): Promise<ProcessGroup[]> {
  const uid = String(process.getuid?.() ?? '');
  // lsof exits 1 when some process can't be read; its output is still good.
  const lsof = (args: string[]) => run('lsof', args, { maxBuffer: 16 << 20 }).then(r => r.stdout, e => String(e.stdout ?? ''));
  const [ps, cwd, listen] = await Promise.all([
    run('ps', ['-U', uid, '-o', 'pid=,ppid=,etime=,command=']).then(r => r.stdout),
    lsof(['-a', '-d', 'cwd', '-u', uid, '-F', 'pn']),
    lsof(['-a', '-nP', '-iTCP', '-sTCP:LISTEN', '-u', uid, '-F', 'pn']),
  ]);
  return buildGroups(parsePs(ps), parseLsof(cwd), parseLsof(listen), roots, process.pid);
}

// Stop a whole tree: SIGTERM to every process in it (a launcher like `composer dev` doesn't always pass
// it on), then SIGKILL to whatever is still there after 3 s.
export async function stopProcessGroup(roots: string[], pid: number): Promise<boolean> {
  const group = (await projectProcesses(roots)).find(g => g.pid === pid);
  if (!group) return false;
  const signal = (sig: NodeJS.Signals) => {
    for (const p of group.pids) try { process.kill(p, sig); } catch { /* already gone */ }
  };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), 3000);
  return true;
}
