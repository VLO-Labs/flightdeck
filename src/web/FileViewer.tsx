// Read-only file viewer: a file with line numbers, or a folder's entries to click through.
import { useEffect, useState } from 'react';
import type { FileResponse, Project } from '../shared/contracts.ts';
import { api } from './api.ts';

export function FileViewer({ project, path, onOpen, onClose }: {
  project: Project; path: string; onOpen: (p: string) => void; onClose: () => void;
}) {
  const [f, setF] = useState<FileResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setF(null);
    setError('');
    api.file(project.id, path).then(setF).catch(e => setError(e.message));
  }, [project.id, path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const parent = path.replace(/\/$/, '').split('/').slice(0, -1).join('/');
  return (
    <div className="viewer-backdrop" onClick={onClose}>
      <div className="viewer" onClick={e => e.stopPropagation()}>
        <header className="viewer-head">
          <span className="mono">{path || '/'}</span>
          <span>
            {path && <button className="link" onClick={() => onOpen(parent ? parent + '/' : '')}>Up</button>}
            {' '}
            <button className="small" onClick={onClose}>Close</button>
          </span>
        </header>
        <div className="viewer-body">
          {error && <div className="error">{error}</div>}
          {f?.kind === 'dir' && (
            <div className="dir">
              {f.entries.map(e => <button key={e} className="link mono file-link" onClick={() => onOpen(f.path + e)}>{e}</button>)}
            </div>
          )}
          {f?.kind === 'binary' && <div className="muted">Binary file, {f.size.toLocaleString()} bytes.</div>}
          {f?.kind === 'file' && (
            <>
              <pre className="code">
                {f.content.split('\n').map((line, i) => (
                  <div key={i} className="code-line"><span className="ln">{i + 1}</span>{line || ' '}</div>
                ))}
              </pre>
              {f.truncated && <div className="muted">Showing the first 512 KB.</div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
