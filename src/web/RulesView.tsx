// A project's approval rules: what runs without asking, what gets a card, what is refused.
import { useEffect, useState } from 'react';
import { MODELS, type Bucket, type Project, type Rule } from '../shared/contracts.ts';
import { api } from './api.ts';

const BUCKETS: { id: Bucket; title: string; help: string }[] = [
  { id: 'deny', title: 'Deny', help: 'Refused outright; the reason is sent to Claude.' },
  { id: 'ask', title: 'Ask', help: 'An approval card. Anything no rule matches also lands here.' },
  { id: 'allow', title: 'Allow', help: 'Runs without asking.' },
];

export function RulesView({ project, onProjectChanged }: { project: Project; onProjectChanged: (p: Project) => void }) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [bucket, setBucket] = useState<Bucket>('allow');
  const [pattern, setPattern] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  const load = () => api.rules(project.id).then(setRules).catch(e => setError(e.message));
  useEffect(() => { void load(); }, [project.id]);

  return (
    <div className="rules">
      <h2>Project settings · {project.name}</h2>

      <h3>Models</h3>
      <p className="muted">Defaults for this project's chats. A chat can override either one in its header.</p>
      <div className="model-defaults">
        {(['discussModel', 'buildModel'] as const).map(field => (
          <label key={field}>
            {field === 'discussModel' ? 'Discuss' : 'Build'}
            <select
              value={project[field]}
              onChange={async e => {
                setError('');
                try {
                  onProjectChanged(await api.projectSettings(project.id, { discussModel: project.discussModel, buildModel: project.buildModel, [field]: e.target.value }));
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              {MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              {!MODELS.some(m => m.id === project[field]) && <option value={project[field]}>{project[field]}</option>}
            </select>
          </label>
        ))}
      </div>

      <h3>Approval rules</h3>
      <p className="muted">
        Same syntax as Claude Code: <code>Read</code>, <code>Bash(npm test:*)</code>, <code>Bash(git push:*)</code>,{' '}
        <code>WebFetch(domain:example.com)</code>, <code>Edit(.env*)</code>. Deny beats Ask beats Allow. A shell command
        joined with <code>&&</code>, <code>;</code> or <code>|</code> is allowed only if every part is. Edits are also
        limited to one chat at a time per project, whatever these rules say.
      </p>

      <form
        className="rule-form"
        onSubmit={async e => {
          e.preventDefault();
          setError('');
          try {
            await api.addRule(project.id, { bucket, pattern, reason: reason || null });
            setPattern('');
            setReason('');
            await load();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <select value={bucket} onChange={e => setBucket(e.target.value as Bucket)}>
          {BUCKETS.map(b => <option key={b.id} value={b.id}>{b.title}</option>)}
        </select>
        <input value={pattern} onChange={e => setPattern(e.target.value)} placeholder="Bash(npm test:*)" />
        <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason (optional)" />
        <button type="submit" disabled={!pattern.trim()}>Add rule</button>
      </form>
      {error && <div className="error">{error}</div>}

      {BUCKETS.map(b => {
        const rows = rules.filter(r => r.bucket === b.id);
        return (
          <section key={b.id} className={`bucket ${b.id}`}>
            <h3>{b.title} <span className="muted">— {b.help}</span></h3>
            {rows.length === 0 && <div className="muted">No rules.</div>}
            {rows.map(r => (
              <div key={r.id} className="rule">
                <code>{r.pattern}</code>
                <span className="muted">{r.reason}</span>
                <button className="link" onClick={async () => { await api.deleteRule(project.id, r.id); await load(); }}>Remove</button>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
