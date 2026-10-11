// Read-only file viewer: a file with line numbers and syntax highlighting, or a folder's entries to
// click through. Opens over the map, so closing it returns to exactly where the map was.
import { useEffect, useMemo, useRef, useState } from 'react';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import type { FileResponse, Project } from '../shared/contracts.ts';
import { api } from './api.ts';

for (const [name, lang] of Object.entries({ bash, css, diff, dockerfile, go, ini, javascript, json, markdown, php, python, sql, typescript, xml, yaml })) {
  hljs.registerLanguage(name, lang);
}

const BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', php: 'php', go: 'go', py: 'python', sql: 'sql',
  sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', env: 'ini',
  css: 'css', scss: 'css', html: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', md: 'markdown', mdx: 'markdown',
  diff: 'diff', patch: 'diff',
};
function languageOf(path: string): string | undefined {
  const name = path.split('/').pop() ?? '';
  if (/^dockerfile/i.test(name)) return 'dockerfile';
  if (/^\.env(\..*)?$/i.test(name)) return 'ini';
  if (/^makefile$/i.test(name)) return 'bash';
  return BY_EXT[name.split('.').pop()?.toLowerCase() ?? ''];
}

// Highlighting a very large file would stall the page; show it plain instead.
const HIGHLIGHT_MAX = 300 * 1024;
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export type MapPlace = { id: string; trail: string }; // a map node that covers the open file

export function FileViewer({ project, path, line, places, onOpen, onClose, onShowOnMap }: {
  project: Project;
  path: string;
  line?: number; // highlight and scroll to this line
  places?: MapPlace[];
  onOpen: (p: string) => void;
  onClose: () => void;
  onShowOnMap?: (id: string) => void;
}) {
  const [f, setF] = useState<FileResponse | null>(null);
  const [error, setError] = useState('');
  const body = useRef<HTMLDivElement>(null);

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

  const code = useMemo(() => {
    if (f?.kind !== 'file') return null;
    const text = f.content.endsWith('\n') ? f.content.slice(0, -1) : f.content;
    const lang = languageOf(path);
    let html: string;
    try {
      html = lang && text.length <= HIGHLIGHT_MAX ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value : escapeHtml(text);
    } catch {
      html = escapeHtml(text);
    }
    const lines = text.split('\n').length;
    return { html, lines, lang, gutter: Array.from({ length: lines }, (_, i) => i + 1).join('\n') };
  }, [f, path]);

  // Bring the requested line into view once the file is on screen.
  useEffect(() => {
    if (!code || !line || !body.current) return;
    const lh = parseFloat(getComputedStyle(body.current).getPropertyValue('--code-lh')) || 20;
    body.current.scrollTop = Math.max(0, (line - 1) * lh - body.current.clientHeight / 3);
  }, [code, line]);

  // Breadcrumb: every folder on the way is a link.
  const parts = path.replace(/\/$/, '').split('/').filter(Boolean);
  const isDir = f?.kind === 'dir' || path.endsWith('/') || path === '';
  return (
    <div className="viewer-backdrop" onClick={onClose}>
      <div className="viewer" role="dialog" aria-label={path || project.name} onClick={e => e.stopPropagation()}>
        <header className="viewer-head">
          <nav className="viewer-crumbs mono">
            <button className="link" onClick={() => onOpen('')}>{project.name}</button>
            {parts.map((p, i) => {
              const last = i === parts.length - 1;
              const to = parts.slice(0, i + 1).join('/') + '/';
              return (
                <span key={to}>
                  <span className="sep">/</span>
                  {last && !isDir ? <strong>{p}</strong> : <button className="link" onClick={() => onOpen(to)}>{p}</button>}
                </span>
              );
            })}
          </nav>
          <span className="viewer-meta">
            {code && <span className="muted">{code.lines.toLocaleString()} lines{code.lang ? ` · ${code.lang}` : ''}</span>}
            <button className="small" onClick={onClose} title="Close (Esc)">Close</button>
          </span>
        </header>
        {places && places.length > 0 && (
          <div className="viewer-places">
            <span className="muted">On the map:</span>
            {places.map(p => (
              <button key={p.id} className="chip" onClick={() => onShowOnMap?.(p.id)} title="Show this on the map">{p.trail}</button>
            ))}
          </div>
        )}
        <div className="viewer-body" ref={body}>
          {error && <div className="error">{error}</div>}
          {!f && !error && <div className="muted">Loading…</div>}
          {f?.kind === 'dir' && (
            <div className="dir">
              {f.entries.length === 0 && <div className="muted">Empty folder.</div>}
              {f.entries.map(e => (
                <button key={e} className={`dir-entry mono ${e.endsWith('/') ? 'is-dir' : ''}`} onClick={() => onOpen(f.path + e)}>{e}</button>
              ))}
            </div>
          )}
          {f?.kind === 'binary' && <div className="muted">Binary file, {f.size.toLocaleString()} bytes.</div>}
          {f?.kind === 'file' && code && (
            <>
              <div className="code-grid">
                {line && line <= code.lines && <div className="code-mark" style={{ top: `calc(${line - 1} * var(--code-lh))` }} />}
                <pre className="code-gutter" aria-hidden="true">{code.gutter}</pre>
                <pre className="code-text"><code className="hljs" dangerouslySetInnerHTML={{ __html: code.html }} /></pre>
              </div>
              {f.truncated && <div className="muted truncated">Showing the first 512 KB.</div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
