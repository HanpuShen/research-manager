import React, { useEffect, useRef, useState } from 'react';
import { paperStatuses, type AppState, type Entity } from '../src/types.js';
import { MarkdownText } from './Markdown.js';
import type { Send } from './EntityDetails.js';

const PDF_LIMIT = 50 * 1024 * 1024;
const paperTone = (status: string) => status === 'Read' ? 'green' : status === 'Reading' ? 'amber' : 'muted';

export function shortAuthors(authors: string[] = []) {
  if (!authors.length) return 'Authors not recorded';
  return authors.length > 3 ? `${authors.slice(0, 3).join(', ')}, et al.` : authors.join(', ');
}

/** Waits for the host's `saved` / `error` reply to a request about one record. */
function useReply(onSaved: (id: string) => void) {
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (!pending) return;
      if (event.data?.type === 'saved' && event.data.id === pending) { setPending(''); onSaved(pending); }
      if (event.data?.type === 'error') { setError(event.data.message); setPending(''); }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [pending, onSaved]);
  return { pending, setPending, error, setError };
}

export function RelatedWork({ state, query, send, onSelect, onAdd }: { state: AppState; query: string; send: Send; onSelect: (id: string) => void; onAdd: () => void }) {
  const [status, setStatus] = useState('all');
  const [tag, setTag] = useState('');
  const papers = state.entities.filter(e => e.kind === 'Paper' && e.projectIds.includes(state.selectedProjectId));
  const tags = [...new Set(papers.flatMap(p => p.metadata.tags || []))].sort();
  const text = (p: Entity) => `${p.title} ${(p.metadata.authors || []).join(' ')} ${p.metadata.venue || ''} ${p.metadata.year || ''} ${(p.metadata.tags || []).join(' ')} ${p.body} ${(p.metadata.code || []).map((c: any) => `${c.url} ${c.name || ''}`).join(' ')}`.toLowerCase();
  const visible = papers.filter(p => (status === 'all' || p.status === status) && (!tag || (p.metadata.tags || []).includes(tag)) && text(p).includes(query.toLowerCase()))
    .sort((a, b) => (b.metadata.year || 0) - (a.metadata.year || 0) || a.title.localeCompare(b.title));
  return <section className="content-list">
    <div className="list-toolbar">
      <div className="segmented" aria-label="Reading status">{['all', ...paperStatuses].map(value => <button key={value} className={status === value ? 'active' : ''} onClick={() => setStatus(value)}>{value === 'all' ? 'All' : value}</button>)}</div>
      {!!tags.length && <label className="compact-label">Tag<select aria-label="Tag" value={tag} onChange={event => setTag(event.target.value)}><option value="">All tags</option>{tags.map(value => <option key={value}>{value}</option>)}</select></label>}
      <span className="quiet">{visible.length} of {papers.length} papers</span>
      <button className="primary toolbar-end" onClick={onAdd}>Add paper</button>
    </div>
    {visible.length ? <div className="paper-list">{visible.map(p => <button className="paper-row" key={p.id} onClick={() => onSelect(p.id)}>
      <span className="paper-main"><strong>{p.title}</strong><small>{shortAuthors(p.metadata.authors)}{p.metadata.year ? ` · ${p.metadata.year}` : ''}{p.metadata.venue ? ` · ${p.metadata.venue}` : ''}</small>
        {!!(p.metadata.tags || []).length && <span className="paper-tags">{p.metadata.tags.map((t: string) => <span className="paper-tag" key={t}>{t}</span>)}</span>}</span>
      <span className="paper-flags">{p.metadata.pdf && <span className="badge muted" title="PDF stored">PDF</span>}{!!(p.metadata.code || []).length && <span className="badge muted" title="Code repository linked">Code</span>}<span className={`badge ${paperTone(p.status)}`}>{p.status}</span></span>
    </button>)}</div>
      : <div className="empty-state"><span className="empty-icon" aria-hidden="true">❝</span><h2>{papers.length ? 'No matching papers' : 'No related work yet'}</h2><p>{papers.length ? 'Try another status, tag, or search.' : 'Paste an arXiv link to fill in the title, authors, abstract, and BibTeX. Add GitHub links for the code.'}</p>{!papers.length && <button className="primary" onClick={onAdd}>Add paper</button>}</div>}
  </section>;
}

export function AddPaperDialog({ projectId, projectTitle, send, onClose, onAdded }: { projectId: string; projectTitle: string; send: Send; onClose: () => void; onAdded: (id: string) => void }) {
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState('');
  const [notes, setNotes] = useState('');
  const { pending, setPending, error, setError } = useReply(id => { onClose(); onAdded(id); });
  return <div className="modal-backdrop"><section className="editor-dialog" role="dialog" aria-modal="true" aria-labelledby="paper-dialog-title" onKeyDown={event => { if (event.key === 'Escape' && !pending) onClose(); }}>
    <div className="dialog-heading"><h2 id="paper-dialog-title">Add paper to {projectTitle}</h2><button className="icon-button" disabled={!!pending} aria-label="Close" onClick={onClose}>×</button></div>
    <form onSubmit={event => {
      event.preventDefault();
      if (pending) return;
      const id = `paper-${crypto.randomUUID()}`;
      setError(''); setPending(id);
      send('addPaper', { id, projectId, url: url.trim(), codeUrls: code.split(/\s+/).filter(Boolean), title: title.trim(), tags: tags.split(',').map(t => t.trim()).filter(Boolean), notes });
    }}>
      <label>Paper link<input aria-label="Paper link" autoFocus value={url} onChange={event => setUrl(event.target.value)} placeholder="https://arxiv.org/abs/2506.04168, an arXiv ID, or any web link" /><small className="quiet">arXiv links fill in the title, authors, year, abstract, and BibTeX. Only the link is sent to arXiv.</small></label>
      <label>Code repositories <span className="quiet">one per line</span><textarea aria-label="Code repositories" rows={2} value={code} onChange={event => setCode(event.target.value)} placeholder="https://github.com/owner/repo" /></label>
      <label>Title <span className="quiet">{/arxiv|^\d{4}\.\d{4,5}/i.test(url) ? 'optional for arXiv links' : 'required for non-arXiv links'}</span><input aria-label="Title" value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label>Tags <span className="quiet">comma separated</span><input aria-label="Tags" value={tags} onChange={event => setTags(event.target.value)} placeholder="baseline, data scaling" /></label>
      <label>Notes <span className="quiet">Markdown, optional</span><textarea aria-label="Paper notes" className="notes-input" rows={5} value={notes} onChange={event => setNotes(event.target.value)} placeholder="Why it matters for this project" /></label>
      <p className="quiet">The paper is stored in this project only. Add a PDF from its details after saving.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions"><button type="button" disabled={!!pending} onClick={onClose}>Cancel</button><button className="primary" disabled={!!pending || (!url.trim() && !title.trim())} type="submit">{pending ? 'Reading metadata…' : 'Add paper'}</button></div>
    </form>
  </section></div>;
}

const formatBytes = (n: number) => n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;

/** Paper-specific part of the details panel: links, PDF, BibTeX, abstract, notes. */
export function PaperDetails({ paper, send }: { paper: Entity; send: Send }) {
  const m = paper.metadata;
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState('');
  const { pending, setPending, error, setError } = useReply(() => setNotice(''));
  const expected = { id: paper.id, expectedRevision: paper.revision, expectedHash: paper.contentHash };
  const run = (command: string, payload: Record<string, unknown> = {}, label = '') => { setError(''); setNotice(label); setPending(paper.id); send(command, { ...expected, ...payload }); };
  const upload = (file?: File) => {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { setError('Choose a PDF file.'); return; }
    if (file.size > PDF_LIMIT) { setError('PDFs are limited to 50 MB.'); return; }
    const reader = new FileReader();
    reader.onerror = () => setError('Could not read the file.');
    reader.onload = () => run('uploadPaperPdf', { name: file.name, dataBase64: String(reader.result).split(',')[1] || '' }, `Uploading ${file.name}…`);
    reader.readAsDataURL(file);
  };
  return <>
    <div className="detail-block paper-meta">
      <p className="paper-authors">{shortAuthors(m.authors)}</p>
      <p className="quiet">{[m.year, m.venue].filter(Boolean).join(' · ') || 'Year and venue not recorded'}</p>
      <label className="compact-label">Reading status<select aria-label="Reading status" value={paper.status} disabled={!!pending} onChange={event => run('saveEntity', { entity: { ...paper, status: event.target.value } })}>{paperStatuses.map(value => <option key={value}>{value}</option>)}</select></label>
      {!!(m.tags || []).length && <span className="paper-tags">{m.tags.map((t: string) => <span className="paper-tag" key={t}>{t}</span>)}</span>}
    </div>
    <div className="detail-block"><h3>Links</h3><div className="source-links">
      {m.paperUrl ? <button className="source-link" onClick={() => send('openSource', { source: { url: m.paperUrl } })} title={m.paperUrl}><span>Paper{m.arxivId ? ` · arXiv ${m.arxivId}` : ''}</span><span>↗</span></button> : <p className="quiet">No paper link recorded.</p>}
      {(m.code || []).map((c: any) => <button key={c.url} className="source-link" onClick={() => send('openSource', { source: { url: c.url } })} title={c.url}><span>Code · {c.name || c.url.replace(/^https?:\/\//, '')}{typeof c.stars === 'number' ? ` · ★ ${c.stars}` : ''}{c.description ? <small className="quiet"> — {c.description}</small> : null}</span><span>↗</span></button>)}
      {!(m.code || []).length && <p className="quiet">No code repository linked. Add one with Edit record.</p>}
    </div>{(m.fetchError || (m.code || []).some((c: any) => c.fetchError)) && <p className="notice subtle">Some metadata could not be read: {[m.fetchError, ...(m.code || []).map((c: any) => c.fetchError)].filter(Boolean).join(' ')}</p>}</div>
    <div className={`detail-block paper-pdf ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); upload(event.dataTransfer.files[0]); }}>
      <h3>PDF</h3>
      {m.pdf ? <p className="quiet">{m.pdf.originalName} · {formatBytes(m.pdf.bytes)} · added {new Date(m.pdf.addedAt).toLocaleDateString()}</p> : <p className="quiet">Drop a PDF here or choose one from this computer. It is stored in the research memory folder, outside Git.</p>}
      <div className="detail-actions">
        {m.pdf && <button className="primary" onClick={() => send('openPaperPdf', { id: paper.id })}>Open PDF ↗</button>}
        <button disabled={!!pending} onClick={() => input.current?.click()}>{m.pdf ? 'Replace PDF' : 'Upload PDF'}</button>
        {m.pdfUrl && !m.pdf && <button disabled={!!pending} onClick={() => run('fetchPaperPdf', {}, 'Downloading from arXiv…')}>Download from arXiv</button>}
        {(m.arxivId || (m.code || []).length > 0) && <button disabled={!!pending} onClick={() => run('refreshPaper', {}, 'Reading metadata…')}>Refresh metadata</button>}
      </div>
      <input ref={input} type="file" accept="application/pdf,.pdf" hidden onChange={event => { upload(event.target.files?.[0]); event.target.value = ''; }} />
      {pending && notice && <p className="quiet" role="status">{notice}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
    {m.abstract && <details className="detail-block paper-abstract"><summary>Abstract</summary><p>{m.abstract}</p></details>}
    {m.bibtex && <details className="detail-block"><summary>BibTeX</summary><pre className="preview-code paper-bibtex">{m.bibtex}</pre><button onClick={() => { void navigator.clipboard?.writeText(m.bibtex).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>{copied ? 'Copied' : 'Copy BibTeX'}</button></details>}
    <div className="detail-block"><h3>Notes</h3>{paper.body.trim() ? <MarkdownText text={paper.body} documentPath={paper.filePath} send={send} /> : <p className="quiet">No notes yet. Use Edit record to add why this paper matters.</p>}</div>
  </>;
}
