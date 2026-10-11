// The workspace's PRD tab: the project's requirements document, read from the repository
// (docs/requirements/PRD.md). Read-only for now; editing, approval and attaching rules to a message
// build on this.
import { useEffect, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { FileResponse, Project } from '../shared/contracts.ts';
import { api } from './api.ts';

// In a multi-repo folder the requirements live in the repository that keeps the maps.
export const prdPath = (project: Project) => `${project.mapsRepo ? `${project.mapsRepo}/` : ''}docs/requirements/PRD.md`;

export function PrdView({ project }: { project: Project }) {
  const path = prdPath(project);
  const [f, setF] = useState<FileResponse | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let gone = false;
    setF(null);
    setMissing(false);
    api.file(project.id, path).then(r => !gone && setF(r)).catch(() => !gone && setMissing(true));
    return () => { gone = true; };
  }, [project.id, path]);

  if (missing || (f && f.kind !== 'file')) {
    return (
      <div className="prd-empty">
        <p><strong>No requirements document yet.</strong></p>
        <p className="muted">
          The PRD lives in the repository at <code>{path}</code>, with feature specs beside it in
          <code> features/</code>. Plain Markdown, versioned with the code.
        </p>
      </div>
    );
  }
  if (!f) return <div className="prd-empty muted">Loading…</div>;
  return (
    <article className="prd md">
      <div className="prd-path muted mono">{path}</div>
      <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{f.content}</Markdown>
    </article>
  );
}

// Links open in a new tab, as in the chat: following one must not leave Flightdeck.
const MD_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
};
