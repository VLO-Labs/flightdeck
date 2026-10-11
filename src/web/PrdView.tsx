// The workspace's PRD tab (PLAN.md §11): the project's requirements — the PRD and one spec per
// feature — read as documents, edited as plain Markdown, approved revision by revision. The files live
// in the repository (docs/requirements); Flightdeck keeps what was approved, so a later edit is a new
// draft and never changes an approved version. Any requirement or section can be attached to the
// chat's next message; edits the agent proposes from a Discuss chat are reviewed here as a diff.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { type MapViewId, type Project, type RequirementDoc, type RequirementDocSummary, type RequirementProposal, type RequirementsResponse } from '../shared/contracts.ts';
import { FEATURE_TEMPLATE, ID_PATTERN, PRD_FILE, REQUIREMENTS_DIR, linkTarget, PRD_TEMPLATE, featureSlug, nextId, parseRequirements } from '../shared/requirements.ts';
import { diffLines, hunks } from '../shared/diff.ts';
import { ApiError, api } from './api.ts';
import { ctxKey, isNodeRef, type ContextRef, type ReqRef } from './workspace.ts';

// An edit in progress, kept while you look at another tab or chat: per project and document.
type Editing = { text: string; baseHash: string | null };
const edits = new Map<string, Editing>();
const lastDoc = new Map<number, string>(); // per project: the document last open

export function PrdView({ project, ctx, onToggle, review, onOpenFile, onRevealNode }: {
  project: Project; ctx: ContextRef[]; onToggle: (r: ReqRef) => void; review: { id: number; seq: number } | null;
  onOpenFile: (path: string, line?: number) => void; onRevealNode: (view: MapViewId, id: string) => void;
}) {
  const [list, setList] = useState<RequirementsResponse | null>(null);
  const [proposals, setProposals] = useState<RequirementProposal[]>([]);
  const [reviewing, setReviewing] = useState<number | null>(null);
  const [path, setPath] = useState(() => lastDoc.get(project.id) ?? PRD_FILE);
  const [doc, setDoc] = useState<RequirementDoc | null>(null);
  const [version, setVersion] = useState<number | undefined>(); // an approved version being read
  const key = `${project.id}:${path}`;
  const [editing, setEditingState] = useState<Editing | null>(() => edits.get(key) ?? null);
  const setEditing = (e: Editing | null) => { if (e) edits.set(key, e); else edits.delete(key); setEditingState(e); };
  const [conflict, setConflict] = useState<{ content: string | null; hash: string | null } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => { lastDoc.set(project.id, path); setEditingState(edits.get(key) ?? null); setConflict(null); setError(''); }, [key]);

  const loadList = useCallback(() => Promise.all([
    api.requirements(project.id).then(setList),
    api.proposals(project.id).then(setProposals),
  ]).catch(e => setError((e as Error).message)), [project.id]);
  // A proposal card's "Review" in the chat opens it here.
  useEffect(() => { if (review) { setReviewing(review.id); void loadList(); } }, [review?.seq]);
  const loadDoc = useCallback(() => {
    api.requirement(project.id, path, version).then(setDoc).catch(e => setError((e as Error).message));
  }, [project.id, path, version]);
  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => { setDoc(null); loadDoc(); }, [loadDoc]);

  // The files can change outside Flightdeck (an editor, git): look every few seconds, and follow the
  // change unless you are editing — then say so before you save over it.
  useEffect(() => {
    const t = setInterval(() => void loadList(), 5000);
    return () => clearInterval(t);
  }, [loadList]);
  const onDisk = list?.docs.find(d => d.path === path);
  const changedOnDisk = Boolean(doc && onDisk && onDisk.hash !== doc.summary.hash);
  useEffect(() => { if (changedOnDisk && !editing) loadDoc(); }, [changedOnDisk, editing, loadDoc]);

  // The list is polled, so it knows first when the file changed on disk; the loaded document, before it loads.
  const summary = onDisk ?? doc?.summary;
  const shown = version !== undefined ? doc?.viewing?.content ?? null : editing ? editing.text : doc?.content ?? null;
  const outline = useMemo(() => (shown ? parseRequirements(shown).outline : []), [shown]);
  const allIds = useMemo(() => list?.docs.flatMap(d => d.ids) ?? [], [list]);
  const isPrd = path === PRD_FILE;

  const open = (p: string) => { setVersion(undefined); setReviewing(null); setPath(p); };
  const startNew = (p: string, text: string) => { open(p); edits.set(`${project.id}:${p}`, { text, baseHash: null }); };

  const save = async (baseHash: string | null) => {
    if (!editing) return;
    setBusy(true);
    setError('');
    try {
      const d = await api.saveRequirement(project.id, path, editing.text, baseHash);
      setDoc(d);
      setEditing(null);
      setConflict(null);
      void loadList();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict((e.body.current as typeof conflict) ?? { content: null, hash: null });
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const approve = async () => {
    if (!doc?.summary.hash) return;
    setBusy(true);
    setError('');
    try {
      setDoc(await api.approveRequirement(project.id, path, doc.summary.hash));
      void loadList();
    } catch (e) {
      setError((e as Error).message);
      loadDoc();
    } finally {
      setBusy(false);
    }
  };

  const scrollTo = (i: number) => {
    const hs = body.current?.querySelectorAll('h1, h2, h3, h4, h5, h6');
    hs?.[i]?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  const insertId = () => {
    const ta = body.current?.querySelector('textarea');
    if (!ta || !editing) return;
    const id = nextId(isPrd ? 'BR' : 'AC', [...allIds, ...parseRequirements(editing.text).items.map(i => i.id)]);
    const snippet = isPrd ? `\n### ${id} · ` : `\n- **${id}** `;
    const at = ta.selectionStart;
    const text = editing.text.slice(0, at) + snippet + editing.text.slice(ta.selectionEnd);
    setEditing({ ...editing, text });
    requestAnimationFrame(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = at + snippet.length; });
  };

  const noFile = doc && doc.content === null;

  // Reading the file as it is now: every requirement and section can be attached to the message.
  const attachable = version === undefined && !editing && doc?.content != null;
  const attached = useMemo(() => new Set(ctx.filter(c => !isNodeRef(c)).map(ctxKey)), [ctx]);
  const docName = isPrd ? 'PRD' : summary?.title ?? path.slice(9, -3);
  // Links in a requirements document: a repository path opens in the Code tab (`#L12` at a line), and
  // `map:<view>/<node-id>` shows that node on its map. Anything else opens in a new tab, so following
  // it never leaves Flightdeck. (Raw HTML is not drawn — skipHtml — so writers' comments stay hidden.)
  const linkComponents = useMemo<Components>(() => ({
    a: ({ node: _n, href, children, ...props }) => {
      const target = linkTarget(href ?? '', `${list?.dir ?? REQUIREMENTS_DIR}/${path}`);
      if (!target) return <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
      const go = (e: React.MouseEvent) => {
        e.preventDefault();
        if (target.kind === 'map') onRevealNode(target.view, target.id);
        else onOpenFile(target.path, target.line);
      };
      return <a {...props} href={href} className="req-link" onClick={go} title={target.kind === 'map' ? `Show on the ${target.view} map` : `Open ${target.path}`}>{children}</a>;
    },
  }), [list?.dir, path, onOpenFile, onRevealNode]);

  const attachComponents = useMemo<Components>(() => {
    const heading = (Tag: 'h1' | 'h2' | 'h3' | 'h4') => ({ node, children }: { node?: HastNode; children?: ReactNode }) => {
      const text = flatText(node).trim();
      const id = leadId(text);
      const r: ReqRef = id
        ? { doc: path, ref: id, label: text.replace(/\s*·\s*/, ' ').slice(0, 80) }
        : { doc: path, ref: `§${text}`, label: `${docName} § ${text}`.slice(0, 80) };
      const on = attached.has(ctxKey(r));
      return (
        <Tag className={`req-target ${on ? 'req-attached' : ''}`}>
          {children}
          <AttachButton on={on} what={id ?? `section “${text}”`} onClick={() => onToggle(r)} />
        </Tag>
      );
    };
    return {
      ...linkComponents,
      h1: heading('h1'), h2: heading('h2'), h3: heading('h3'), h4: heading('h4'),
      li: ({ node, children }) => {
        const text = flatText(node as HastNode).trim();
        const id = leadId(text);
        if (!id) return <li>{children}</li>;
        const r: ReqRef = { doc: path, ref: id, label: text.slice(0, 80) };
        const on = attached.has(ctxKey(r));
        return (
          <li className={`req-target ${on ? 'req-attached' : ''}`}>
            {children}
            <AttachButton on={on} what={id} onClick={() => onToggle(r)} />
          </li>
        );
      },
    };
  }, [path, docName, attached, onToggle, linkComponents]);
  return (
    <div className="req">
      <nav className="req-nav" aria-label="Requirements">
        <div className="req-nav-h">Documents</div>
        {(list?.docs ?? []).map(d => (
          <button
            key={d.path} className={`req-doc-item ${d.path === path ? 'active' : ''}`} aria-current={d.path === path ? 'page' : undefined}
            disabled={Boolean(editing) && d.path !== path} title={editing && d.path !== path ? 'Save or cancel your edit first' : d.path}
            onClick={() => open(d.path)}
          >
            <span className="req-doc-name">{d.path === PRD_FILE ? 'PRD' : d.title ?? d.path.slice(9, -3)}</span>
            <StateBadge s={d} compact />
          </button>
        ))}
        {!list?.docs.some(d => d.path === path) && <div className="req-doc-item active"><span className="req-doc-name">{path.slice(9, -3)}</span><span className="badge">new</span></div>}
        <NewFeature disabled={Boolean(editing)} docs={list?.docs ?? []} onCreate={(p, name) => startNew(p, FEATURE_TEMPLATE(name))} onOpen={open} />
        {proposals.some(x => x.status === 'open') && (
          <>
            <div className="req-nav-h">Proposed edits</div>
            {proposals.filter(x => x.status === 'open').map(x => (
              <button
                key={x.id} className={`req-doc-item ${reviewing === x.id ? 'active' : ''}`} disabled={Boolean(editing)}
                title={`${x.summary}\nfrom “${x.chatTitle}”`} onClick={() => setReviewing(x.id)}
              >
                <span className="req-doc-name">#{x.id} {x.path === PRD_FILE ? 'PRD' : x.path.slice(9, -3)}</span>
                <span className="badge warn">review</span>
              </button>
            ))}
          </>
        )}
        {outline.length > 0 && (
          <>
            <div className="req-nav-h">Outline</div>
            {outline.map((o, i) => (
              <button key={`${o.line}`} className={`req-outline l${Math.min(o.level, 4)}`} onClick={() => scrollTo(i)} title={o.title}>
                {o.title}
              </button>
            ))}
          </>
        )}
      </nav>

      {reviewing !== null ? (
        <ProposalReview
          key={reviewing} project={project} proposal={proposals.find(x => x.id === reviewing)}
          onClose={() => setReviewing(null)}
          onDecided={(x, accepted) => { void loadList(); if (accepted) { setReviewing(null); setVersion(undefined); setPath(x.path); loadDoc(); } }}
        />
      ) : (
      <div className="req-main">
        <div className="req-bar">
          <span className="mono muted req-path" title={`${list?.dir ?? ''}/${path}`}>{list?.dir}/{path}</span>
          {summary && <StateBadge s={summary} />}
          {summary?.git === 'untracked' && <span className="badge" title="Not committed yet: commit it like any other file.">not in git yet</span>}
          {summary?.git === 'modified' && <span className="badge" title="Changed since the last commit.">uncommitted</span>}
          <span className="req-bar-spacer" />
          {doc && doc.versions.length > 0 && !editing && (
            <select value={version ?? ''} onChange={e => setVersion(e.target.value ? Number(e.target.value) : undefined)} aria-label="Version">
              <option value="">The file now</option>
              {doc.versions.map((v, i) => (
                <option key={v.version} value={v.version}>
                  v{v.version} · {i === 0 ? 'approved' : 'superseded'} {new Date(v.approvedAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}
                </option>
              ))}
            </select>
          )}
          {!editing && version === undefined && doc?.content != null && (
            <button className="small ghost" onClick={() => setEditing({ text: doc.content!, baseHash: doc.summary.hash })}>Edit</button>
          )}
          {!editing && version === undefined && doc?.content != null && (doc.summary.state === 'draft' || doc.summary.state === 'changed') && (
            <button
              className="small" disabled={busy || changedOnDisk}
              title={`Approve exactly this text as v${(doc.summary.approved?.version ?? 0) + 1}. Build uses the approved version; later edits become a new draft.`}
              onClick={approve}
            >
              Approve as v{(doc.summary.approved?.version ?? 0) + 1}
            </button>
          )}
          {editing && (
            <>
              <button className="small ghost" onClick={insertId} title={`Insert the next free ${isPrd ? 'rule' : 'criterion'} id at the cursor`}>
                + {isPrd ? 'Rule' : 'Criterion'} id
              </button>
              <button className="small ghost" disabled={busy} onClick={() => { setEditing(null); setConflict(null); setError(''); if (noFile && !list?.docs.some(d => d.path === path)) open(PRD_FILE); }}>Cancel</button>
              <button className="small" disabled={busy || Boolean(conflict)} onClick={() => save(editing.baseHash)}>{busy ? 'Saving…' : 'Save'}</button>
            </>
          )}
        </div>

        {summary?.state === 'changed' && version === undefined && (
          <div className="req-note warn">
            Changed since approved v{summary.approved?.version}. Until you approve this revision, Build keeps using v{summary.approved?.version}.
          </div>
        )}
        {summary?.state === 'missing' && version === undefined && (
          <div className="req-note bad">The file is gone from the repository; approved v{summary.approved?.version} is kept here. Pick it above to read it.</div>
        )}
        {version !== undefined && doc && (
          <div className="req-note">
            Reading approved v{version}{doc.versions[0]?.version === version ? ' (the current approval)' : `, superseded by v${doc.versions[0]?.version}`}. Read-only.
          </div>
        )}
        {editing && changedOnDisk && !conflict && (
          <div className="req-note warn">The file changed on disk while you were editing. Saving will ask what to keep.</div>
        )}
        {conflict && editing && (
          <div className="req-note warn req-conflict" role="alert">
            <span>{conflict.content === null ? 'The file was deleted' : 'The file changed on disk'} since you started editing.</span>
            {conflict.content !== null && (
              <button className="small ghost" onClick={() => { setEditing({ text: conflict.content!, baseHash: conflict.hash }); setConflict(null); }}>
                Load theirs (drop my edit)
              </button>
            )}
            <button className="small" onClick={() => save(conflict.hash)}>Save mine over it</button>
          </div>
        )}
        {error && <div className="req-note bad" role="alert">{error}</div>}

        <div className="req-body" ref={body}>
          {editing ? (
            <textarea
              className="req-editor" value={editing.text} spellCheck
              aria-label={`Edit ${path}`}
              onChange={e => setEditing({ ...editing, text: e.target.value })}
              onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); void save(editing.baseHash); } }}
            />
          ) : !doc ? (
            <div className="prd-empty muted">Loading…</div>
          ) : shown !== null ? (
            <article className="prd md">
              <Markdown remarkPlugins={[remarkGfm]} components={attachable ? attachComponents : linkComponents} skipHtml urlTransform={keepMapLinks}>{shown}</Markdown>
            </article>
          ) : noFile && isPrd ? (
            <div className="prd-empty">
              <p><strong>No requirements document yet.</strong></p>
              <p className="muted">
                The PRD says what the software must do: who it's for, its goals and scope, and business rules with
                ids that stay fixed once approved. It's a Markdown file in the repository at <code>{list?.dir}/{PRD_FILE}</code>,
                with a spec per feature beside it in <code>features/</code>, so it's versioned with the code and
                readable anywhere.
              </p>
              <button onClick={() => setEditing({ text: PRD_TEMPLATE(project.name), baseHash: null })}>Start the PRD</button>
            </div>
          ) : (
            <div className="prd-empty muted">No file.</div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

const STATE: Record<RequirementDocSummary['state'], { label: (v?: number) => string; tone: string; title: string }> = {
  draft: { label: () => 'draft', tone: '', title: 'Never approved.' },
  approved: { label: v => `approved v${v}`, tone: 'good', title: 'The file is exactly the approved version.' },
  changed: { label: v => `changed since v${v}`, tone: 'warn', title: 'Edited since the last approval: a draft revision.' },
  missing: { label: () => 'file missing', tone: 'bad', title: 'Approved before; the file is gone.' },
};
function StateBadge({ s, compact }: { s: RequirementDocSummary; compact?: boolean }) {
  const st = STATE[s.state];
  const label = compact && s.state === 'changed' ? 'changed' : st.label(s.approved?.version);
  return <span className={`badge ${st.tone}`} title={st.title}>{label}</span>;
}

function NewFeature({ docs, disabled, onCreate, onOpen }: {
  docs: RequirementDocSummary[]; disabled: boolean; onCreate: (path: string, name: string) => void; onOpen: (path: string) => void;
}) {
  const [name, setName] = useState<string | null>(null);
  if (name === null) return <button className="link req-new" disabled={disabled} onClick={() => setName('')}>+ Feature spec</button>;
  const slug = featureSlug(name);
  const p = `features/${slug}.md`;
  const exists = docs.some(d => d.path === p);
  return (
    <form className="req-new-form" onSubmit={e => { e.preventDefault(); if (!slug) return; if (exists) onOpen(p); else onCreate(p, name.trim()); setName(null); }}>
      <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Feature name" aria-label="Feature name"
        onKeyDown={e => e.key === 'Escape' && setName(null)} />
      {slug && <span className="muted mono req-new-path">{p}{exists ? ' (exists: open it)' : ''}</span>}
      <div className="form-actions">
        <button type="submit" className="small" disabled={!slug}>{exists ? 'Open' : 'Create'}</button>
        <button type="button" className="small ghost" onClick={() => setName(null)}>Cancel</button>
      </div>
    </form>
  );
}

// `map:` isn't a scheme react-markdown keeps by default; everything else gets its usual cleaning.
const keepMapLinks = (url: string) => (url.startsWith('map:') ? url : defaultUrlTransform(url));

type HastNode = { type?: string; value?: string; children?: HastNode[] };
const flatText = (n?: HastNode): string => (!n ? '' : n.type === 'text' ? n.value ?? '' : (n.children ?? []).map(flatText).join(''));
const LEAD = new RegExp(`^(${ID_PATTERN.source})(?![\\w-])`);
const leadId = (text: string) => LEAD.exec(text)?.[1] ?? null;

function AttachButton({ on, what, onClick }: { on: boolean; what: string; onClick: () => void }) {
  return (
    <button
      className={`req-attach ${on ? 'on' : ''}`} aria-pressed={on} onClick={onClick}
      title={on ? `Remove ${what} from your message` : `Attach ${what} to your message`}
    >
      {on ? '✓ in message' : '+ chat'}
    </button>
  );
}

// An edit the agent proposed: what it says, the change as a diff against the file now, Accept / Reject.
function ProposalReview({ project, proposal, onClose, onDecided }: {
  project: Project; proposal?: RequirementProposal; onClose: () => void; onDecided: (p: RequirementProposal, accepted: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [p, setP] = useState(proposal);
  useEffect(() => { if (proposal) setP(proposal); }, [proposal]);
  const diff = useMemo(() => (p ? hunks(diffLines(p.current ?? '', p.content)) : []), [p]);
  if (!p) return <div className="req-main"><div className="prd-empty muted">Loading the proposal…</div></div>;
  const stale = p.status === 'open' && p.baseHash !== p.currentHash;
  const decide = async (accept: boolean) => {
    setBusy(true);
    setError('');
    try {
      const r = await api.decideProposal(project.id, p.id, accept);
      setP(r);
      onDecided(r, accept);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const added = diff.reduce((n, h) => n + ('lines' in h ? h.lines.filter(l => l.op === 'add').length : 0), 0);
  const removed = diff.reduce((n, h) => n + ('lines' in h ? h.lines.filter(l => l.op === 'del').length : 0), 0);
  return (
    <div className="req-main">
      <div className="req-bar">
        <span><strong>Proposed edit #{p.id}</strong> <span className="mono muted">{p.path}</span></span>
        <span className={`badge ${p.status === 'open' ? 'warn' : p.status === 'accepted' ? 'good' : ''}`}>{p.status}</span>
        <span className="muted">+{added} −{removed}</span>
        <span className="req-bar-spacer" />
        {p.status === 'open' && (
          <>
            <button className="small ghost" disabled={busy} onClick={() => decide(false)}>Reject</button>
            <button className="small" disabled={busy || stale} title={stale ? 'The document changed since this was proposed.' : 'Write this into the file as a draft revision; approving it is a separate step.'} onClick={() => decide(true)}>Accept</button>
          </>
        )}
        <button className="small ghost" onClick={onClose}>Close</button>
      </div>
      <div className="req-note">
        {p.summary} <span className="muted">— from “{p.chatTitle}”, {new Date(p.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</span>
      </div>
      {p.status === 'open' && !stale && (
        <div className="req-note muted">Accepting writes it to the file as a draft. Approved versions don't change; you approve the new revision separately.</div>
      )}
      {stale && <div className="req-note warn">The document changed since this was proposed, so it can't be applied as is. Reject it and ask the agent to propose again against the current text.</div>}
      {p.current === null && p.status === 'open' && <div className="req-note">A new document.</div>}
      {error && <div className="req-note bad" role="alert">{error}</div>}
      <div className="req-body">
        <div className="req-diff mono" role="table" aria-label="Proposed changes">
          {diff.length === 0 && <div className="muted">No changes.</div>}
          {diff.map((h, i) => 'skipped' in h
            ? <div key={i} className="req-diff-skip">⋯ {h.skipped} unchanged line{h.skipped > 1 ? 's' : ''}</div>
            : h.lines.map((l, j) => (
                <div key={`${i}:${j}`} className={`req-diff-line ${l.op}`} role="row">
                  <span className="req-diff-n" aria-hidden="true">{l.op === 'add' ? '' : l.a}</span>
                  <span className="req-diff-n" aria-hidden="true">{l.op === 'del' ? '' : l.b}</span>
                  <span className="req-diff-sign" aria-label={l.op === 'add' ? 'added' : l.op === 'del' ? 'removed' : undefined}>{l.op === 'add' ? '+' : l.op === 'del' ? '−' : ' '}</span>
                  <span className="req-diff-text">{l.text || ' '}</span>
                </div>
              )))}
        </div>
      </div>
    </div>
  );
}
