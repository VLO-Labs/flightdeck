// Requirements documents (PLAN.md §11): plain Markdown in the repository, read here for the parts
// Flightdeck cares about — the outline, and the requirement ids that make rules and criteria
// addressable. Pure, so server and UI read a document the same way.
//
// An id is an upper-case prefix, a dash and at least three digits (BR-001, AC-014), and counts where
// it starts a heading or a list item, optionally in bold: `### BR-001 · Refunds need a reason`,
// `- **AC-003** The user sees …`. Ids are unique across all of a project's requirements documents
// and never renumbered: a rule that no longer applies stays, marked retired (`(retired)` in its
// line, or the id struck through: `~~BR-004~~`).

import { MapViewId } from './contracts.ts';

export type RequirementItem = {
  id: string;
  title: string; // the rest of its line, without the id and markers
  kind: 'heading' | 'item';
  line: number; // 1-based
  retired: boolean;
  text: string; // the Markdown it covers: a heading to the next heading of its level or above; an item, its own lines
};
export type OutlineEntry = { level: number; title: string; line: number; id?: string };
export type ParsedRequirements = { title: string | null; outline: OutlineEntry[]; items: RequirementItem[]; duplicates: string[] };

export const ID_PATTERN = /[A-Z]{1,6}-\d{3,}/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
// An id at the start of a line's text: plain, bold, struck, or bold and struck.
const LEAD_ID = /^(\*\*|__)?(~~)?([A-Z]{1,6}-\d{3,})(~~)?(\*\*|__)?(?![\w-])\s*(?:[·:—–-]\s*)?/;
const FENCE = /^\s*(```|~~~)/;

export function parseRequirements(md: string): ParsedRequirements {
  const lines = md.split('\n');
  const outline: OutlineEntry[] = [];
  const items: (RequirementItem & { level: number; end: number })[] = [];
  let fence: string | null = null;
  let openItem: (typeof items)[number] | null = null;
  let itemIndent = 0;

  const lead = (s: string) => {
    const m = LEAD_ID.exec(s);
    if (!m) return null;
    const rest = s.slice(m[0].length).trim();
    return { id: m[3]!, rest, retired: Boolean(m[2] && m[4]) || /\(retired\)/i.test(rest) };
  };

  let comment = false;
  lines.forEach((raw, i) => {
    const line = i + 1;
    // Code blocks and HTML comments (the templates' examples live in one) hold no requirements.
    const f = FENCE.exec(raw);
    if (fence !== null) { if (f?.[1] === fence) fence = null; return; }
    if (f) { fence = f[1]!; return; }
    if (comment) { if (raw.includes('-->')) comment = false; return; }
    if (raw.trimStart().startsWith('<!--')) { comment = !raw.includes('-->'); return; }
    // A list item runs until a blank line followed by something not indented under it, or the next item/heading.
    if (openItem) {
      const indented = raw.trim() === '' || raw.length - raw.trimStart().length > itemIndent;
      if (!indented || ITEM.test(raw) && raw.length - raw.trimStart().length <= itemIndent || HEADING.test(raw)) {
        openItem.end = lastNonBlank(lines, i - 1);
        openItem = null;
      }
    }
    const h = HEADING.exec(raw);
    if (h) {
      const level = h[1]!.length;
      const l = lead(h[2]!);
      const title = l ? stripRetired(l.rest) : h[2]!.replace(/[*_~`]/g, '');
      outline.push({ level, title: l ? `${l.id} · ${title}` : title, line, ...(l ? { id: l.id } : {}) });
      // Close headings this one ends.
      for (const it of items) if (it.kind === 'heading' && it.end === -1 && it.level >= level) it.end = lastNonBlank(lines, i - 1);
      if (l) items.push({ id: l.id, title, kind: 'heading', line, retired: l.retired, text: '', level, end: -1 });
      return;
    }
    const it = ITEM.exec(raw);
    if (it) {
      const l = lead(it[2]!);
      if (l) {
        openItem = { id: l.id, title: stripRetired(l.rest), kind: 'item', line, retired: l.retired, text: '', level: 99, end: -1 };
        itemIndent = it[1]!.length;
        items.push(openItem);
      }
    }
  });
  for (const it of items) if (it.end === -1) it.end = lastNonBlank(lines, lines.length - 1);

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const it of items) { if (seen.has(it.id)) duplicates.add(it.id); seen.add(it.id); }

  return {
    title: outline.find(o => o.level === 1)?.title ?? null,
    outline,
    items: items.map(({ level: _l, end, ...rest }) => ({ ...rest, text: lines.slice(rest.line - 1, end + 1).join('\n') })),
    duplicates: [...duplicates],
  };
}

function lastNonBlank(lines: string[], from: number): number {
  let i = from;
  while (i > 0 && lines[i]!.trim() === '') i--;
  return i;
}
const stripRetired = (s: string) => s.replace(/\s*\(retired\)\s*/i, ' ').replace(/[*_~`]/g, '').trim();

// Whether a new revision of one document may be saved. `kept` are the ids this document must keep —
// what its current file and every approved version of it contain — and `elsewhere` the ids other
// documents use. An id may move to another document (it is then in `elsewhere`), but never vanish.
export function checkRevision(next: ParsedRequirements, kept: Iterable<string>, elsewhere: Iterable<string>): string[] {
  const errors: string[] = [];
  if (next.duplicates.length) errors.push(`Duplicate id${next.duplicates.length > 1 ? 's' : ''}: ${next.duplicates.join(', ')}. Each id names one requirement.`);
  const here = new Set(next.items.map(i => i.id));
  const other = new Set(elsewhere);
  const clash = [...here].filter(id => other.has(id));
  if (clash.length) errors.push(`Already used in another document: ${clash.join(', ')}.`);
  const gone = [...new Set(kept)].filter(id => !here.has(id) && !other.has(id)).sort(byId);
  if (gone.length) {
    errors.push(`Removed: ${gone.join(', ')}. Ids are never dropped or renumbered — keep the line and mark it retired, e.g. "### ~~${gone[0]}~~ … (retired)".`);
  }
  return errors;
}

// The next free id for a prefix: one above the highest ever used, retired ones included.
export function nextId(prefix: string, used: Iterable<string>): string {
  let max = 0;
  for (const id of used) {
    const m = /^([A-Z]{1,6})-(\d+)$/.exec(id);
    if (m && m[1] === prefix) max = Math.max(max, Number(m[2]));
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

export const byId = (a: string, b: string) => {
  const [pa, na] = a.split('-');
  const [pb, nb] = b.split('-');
  return pa === pb ? Number(na) - Number(nb) : pa!.localeCompare(pb!);
};

// Where a project keeps them, relative to its repository: the PRD and one file per feature.
export const REQUIREMENTS_DIR = 'docs/requirements';
export const PRD_FILE = 'PRD.md';
export const FEATURE_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const isDocPath = (p: string) => p === PRD_FILE || (p.startsWith('features/') && p.endsWith('.md') && FEATURE_SLUG.test(p.slice(9, -3)));
export const featureSlug = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);

// Starting points. Deliberately empty of rules: the ids in a document are the project's own.
export const PRD_TEMPLATE = (project: string) => `# ${project} — Product requirements

## Purpose
<!-- What the software is for, in two or three sentences. -->

## Intended users
<!-- Who uses it, and what each of them needs from it. -->

## Goals
<!-- The outcomes that tell us it works. -->

## Scope
### In scope
### Out of scope

## Major features
<!-- One line each; the detail goes in features/<name>.md. -->

## Business rules
<!-- Rules that hold everywhere. One heading per rule, with an id that never changes:

### BR-### · Short name
What must always (or never) happen, stated so it can be checked.

A rule that no longer applies keeps its id and is marked "(retired)". -->

## Open questions
`;

export const FEATURE_TEMPLATE = (name: string) => `# ${name}

## Summary
<!-- What this feature does and for whom. -->

## Scenarios
<!-- The main paths through it, step by step. -->

## Edge cases

## Constraints
<!-- Limits, dependencies, rules from the PRD it relies on (by id, e.g. BR-002). -->

## Links
<!-- Where it lives, once it does: map nodes as [Checkout API](map:architecture/<node-id>), files as
[checkout.ts](src/checkout.ts#L10), and its tests. A link points the way; it is not proof that a
requirement is met — code and tests are. -->

## Open questions

## Acceptance criteria
<!-- Observable results, one per line, each with an id that never changes:
- **AC-###** Given …, when …, then …
-->
`;

// The part of a document a reference names: a requirement id (BR-001), or a section by its heading
// (`§Scope`) — the heading to the next heading of its level or above. Null when it isn't there.
export function findRef(md: string, ref: string): { label: string; text: string; retired?: boolean } | null {
  const parsed = parseRequirements(md);
  if (!ref.startsWith('§')) {
    const it = parsed.items.find(i => i.id === ref);
    return it ? { label: `${it.id} ${it.title}`.trim(), text: it.text, retired: it.retired } : null;
  }
  const title = ref.slice(1).trim();
  const at = parsed.outline.findIndex(o => !o.id && o.title === title);
  if (at === -1) return null;
  const head = parsed.outline[at]!;
  const next = parsed.outline.slice(at + 1).find(o => o.level <= head.level);
  const lines = md.split('\n');
  const text = lines.slice(head.line - 1, next ? next.line - 1 : lines.length).join('\n').trimEnd();
  return { label: `§ ${title}`, text };
}

// Where a link in a document points, if inside Flightdeck. `docPath` is the document's path in the
// project; `./` and `../` are relative to its folder, other relative paths to the repository root.
export function linkTarget(href: string, docPath: string):
  | { kind: 'map'; view: MapViewId; id: string } | { kind: 'file'; path: string; line?: number } | null {
  const m = /^map:([a-z-]+)\/(.+)$/.exec(href);
  if (m) {
    const view = MapViewId.safeParse(m[1]);
    return view.success ? { kind: 'map', view: view.data, id: decodeURIComponent(m[2]!) } : null;
  }
  if (href === '' || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return null;
  const [raw, hash] = href.split('#');
  const line = /^L(\d+)/.exec(hash ?? '')?.[1];
  const repoRoot = docPath.slice(0, docPath.indexOf(REQUIREMENTS_DIR));
  const base = raw!.startsWith('./') || raw!.startsWith('../') ? docPath.split('/').slice(0, -1) : repoRoot.split('/').filter(Boolean);
  const parts = [...base];
  for (const seg of decodeURIComponent(raw!).replace(/^\//, '').split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return { kind: 'file', path: parts.join('/') + (raw!.endsWith('/') ? '/' : ''), ...(line ? { line: Number(line) } : {}) };
}
