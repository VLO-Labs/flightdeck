// Shell-command reading shared by the hook (server) and the approval card (web): how a command
// splits into the commands it really runs, and which of those are known not to change anything.

// Split a shell command into the commands it actually runs. Naive about quoting on purpose:
// over-splitting only produces fragments that match no Allow rule, which makes a call *stricter*.
export function splitCommand(cmd: string): string[] {
  // A lone `&` separates commands, but not inside redirections like `2>&1` or `&>`.
  return cmd.split(/&&|\|\||;|\||(?<![>&])&(?![>&])|\n/).map(s => s.trim()).filter(Boolean);
}

// Constructs that hide a second command inside the first. A prefix rule must never wave these through.
export const HIDDEN_EXEC = /\$\(|`|<\(|>\(/;

// Output redirection writes files (`cat a > b`), so an allow rule for the command must not cover it.
// Redirections between streams or into /dev/null are harmless and stay allowed.
export function writesViaRedirect(cmd: string): boolean {
  const harmless = cmd.replace(/\d?>>?\s*\/dev\/null|\d?>&\d|&>\s*\/dev\/null/g, '');
  return />/.test(harmless);
}

// Commands known not to change files or state (with the forms that would, excluded). Used to keep
// Discuss mode read-only: a command outside this list asks first, even when a rule would allow it.
const READ_ONLY: { cmd: RegExp; unless?: RegExp }[] = [
  { cmd: /^git (status|diff|log|show|blame|ls-files|rev-parse|grep|shortlog|describe)\b/, unless: /--output\b/ },
  { cmd: /^git branch( (-a|-r|-l|--list|-v|-vv|--show-current))*$/ },
  { cmd: /^git remote( -v)?$/ },
  // Not `env` (it runs the command that follows) or `date` (it can set the clock).
  { cmd: /^(ls|cat|head|tail|wc|pwd|du|df|stat|file|which|whoami|uname|printenv)\b/ },
  { cmd: /^tree\b/, unless: /\s-o\b/ }, // -o writes the listing to a file
  { cmd: /^(grep|egrep|fgrep)\b/ },
  { cmd: /^rg\b/, unless: /--pre\b/ }, // --pre runs a program on each file
  { cmd: /^find\b/, unless: /\s-(exec|execdir|delete|ok|okdir|fprint|fprintf|fls)\b/ },
  { cmd: /^(echo|printf)\b/ }, // writes only through a redirect, which is checked separately
];

export function isReadOnlyCommand(part: string): boolean {
  const c = part.trim();
  return READ_ONLY.some(r => r.cmd.test(c) && !(r.unless && r.unless.test(c)));
}

// True when every command a shell line runs is read-only, and nothing is hidden or redirected.
export function isReadOnlyShell(command: string): boolean {
  const parts = splitCommand(command);
  return parts.length > 0 && parts.every(isReadOnlyCommand) && !HIDDEN_EXEC.test(command) && !writesViaRedirect(command);
}

