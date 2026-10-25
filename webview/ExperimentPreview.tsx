import React, { useEffect, useRef, useState } from 'react';
import type { Entity, EntityPreview, PreviewRecord, SourcePreview } from '../src/types.js';
import type { Send } from './EntityDetails.js';
import { MarkdownText, PreviewImage } from './Markdown.js';
import { Review, observationOrder } from './Review.js';

function relatedRecords(entity: Entity, entities: Entity[]): Entity[] {
  if (entity.kind !== 'Experiment') return [];
  return entities.filter(other => (other.kind === 'Artifact' || other.kind === 'Note') && (entity.links.some(link => link.target === other.id) || other.links.some(link => link.target === entity.id)));
}

function useEntityPreview(entity: Entity, related: Entity[], send: Send) {
  const [preview, setPreview] = useState<EntityPreview>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const sender = useRef(send);
  sender.current = send;
  const signature = [entity, ...related].map(item => `${item.id}:${item.contentHash || item.revision}`).sort().join('|');
  useEffect(() => {
    const token = `${entity.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type !== 'entityPreview' || data.entityId !== entity.id || data.token !== token) return;
      setLoading(false);
      if (data.error) setError(data.error);
      else { setPreview(data.preview); setError(''); }
    };
    window.addEventListener('message', receive);
    setLoading(true); setError(''); setPreview(undefined);
    sender.current('previewEntity', { id: entity.id, token });
    return () => window.removeEventListener('message', receive);
  }, [entity.id, signature, refresh]);
  return { preview, loading, error, reload: () => setRefresh(value => value + 1) };
}

function fileName(item: SourcePreview) { return item.source.label || item.source.path?.split('/').pop() || item.source.url || 'Source'; }
function isSetup(item: SourcePreview) { return item.role === 'setup' || /^(config|configuration|setup)(\.|$)/i.test(item.source.path?.split('/').pop() || ''); }
function sourceKey(item: SourcePreview) { return item.source.path || item.source.url || fileName(item); }

export function resultSections(body: string): string {
  let selected = false, fence = '', output: string[] = [];
  for (const line of body.split('\n')) {
    const marker = line.match(/^\s*(```+|~~~+)/)?.[1];
    if (marker) fence = fence ? marker[0] === fence[0] && marker.length >= fence.length ? '' : fence : marker;
    const heading = !fence && line.match(/^#{1,2}\s+(.+)/)?.[1];
    if (heading) selected = /^(results?\b|observations?\b|completion\b|findings\b|outcomes?\b|measured\b)/i.test(heading);
    if (selected) output.push(line);
  }
  return output.join('\n').trim();
}

export function SourceContent({ item, send }: { item: SourcePreview; send: Send }) {
  return <div className={`source-preview source-preview-${item.kind}`}>
    <div className="preview-source-heading"><strong>{fileName(item)}</strong><button className="text-button" onClick={() => send('openSource', { source: item.source })}>Open file ↗</button></div>
    {item.group && <p className="quiet preview-source-group">{item.group}</p>}
    {(item.kind === 'image' || item.readingGuide) && <div className="reading-guide"><strong>{item.kind === 'image' ? 'How to read this figure' : 'How to read this table'}</strong>{item.readingGuide ? <MarkdownText text={item.readingGuide} documentPath={item.source.path} send={send} /> : <p className="quiet">No reading guide recorded. Enlarge the figure to inspect axes and legend, compare the same conditions, and check the baseline and uncertainty definition.</p>}</div>}
    {item.kind === 'image' && item.dataUrl && <PreviewImage src={item.dataUrl} alt={fileName(item)} caption={item.caption} />}
    {item.kind === 'table' && <><div className="preview-table-scroll" tabIndex={0} role="region" aria-label={`Table: ${fileName(item)}`}><table><thead><tr>{item.columns?.map((column, i) => <th scope="col" key={i}>{column || `Column ${i + 1}`}</th>)}</tr></thead><tbody>{item.rows?.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div><p className="quiet preview-row-count">{item.rows?.length || 0} rows shown{item.truncated ? ' · Preview limited. Open the file for all rows and columns.' : ''}</p></>}
    {item.kind === 'markdown' && <MarkdownText text={item.text || ''} images={item.images} documentPath={item.source.path} send={send} />}
    {(item.kind === 'json' || item.kind === 'text') && <pre className="preview-code"><code>{item.text}</code></pre>}
    {(item.kind === 'error' || item.kind === 'unsupported') && <p className={`quiet ${item.kind === 'error' ? 'preview-read-error' : ''}`}>{item.message || 'Open this file to view its contents.'}</p>}
    {item.message && item.kind !== 'error' && item.kind !== 'unsupported' && <p className="notice subtle">{item.message}</p>}
    {item.truncated && item.kind !== 'table' && <p className="quiet">Preview limited. Open the file for the complete content.</p>}
  </div>;
}

function Files({ sources, send, expandedLimit = Infinity }: { sources: SourcePreview[]; send: Send; expandedLimit?: number }) {
  return <div className="preview-files">{sources.map((item, index) => item.kind === 'error' || index < expandedLimit && (item.kind === 'image' || item.kind === 'table' || item.kind === 'markdown') ? <SourceContent key={`${sourceKey(item)}:${index}`} item={item} send={send} /> : <details className="preview-file-disclosure" key={`${sourceKey(item)}:${index}`}><summary>{fileName(item)}<span>{item.kind === 'unsupported' ? 'Open file' : item.kind === 'table' ? `${item.rows?.length || 0} rows × ${item.columns?.length || 0} columns${item.truncated ? ' · limited' : ''}` : item.kind.toUpperCase()}</span></summary><SourceContent item={item} send={send} /></details>)}</div>;
}

function RecordNotes({ title, records, send, onSelect, initiallyOpen = false }: { title: string; records: PreviewRecord[]; send: Send; onSelect: (id: string) => void; initiallyOpen?: boolean }) {
  if (!records.length) return null;
  return <section className="preview-section"><h3>{title} <span className="quiet">{records.length}</span></h3>{records.map((record, index) => <details className="preview-note" key={record.entity.id} open={initiallyOpen && index === 0}>
    <summary>{record.entity.title}{record.entity.status === 'Invalid' && <span className="badge red">Invalid evidence</span>}</summary>
    {record.entity.metadata.role === 'Interpretation' && <p className="quiet preview-note-label">Interpretation{record.entity.metadata.proposedStatus ? ` · Suggested: ${record.entity.metadata.proposedStatus}` : ''} · Not a confirmed claim judgment</p>}
    {record.entity.status === 'Invalid' && <p className="notice">This evidence is invalid. {String(record.entity.metadata.invalidationReason || '')}</p>}
    <MarkdownText text={record.entity.body} images={record.images} documentPath={record.entity.filePath} send={send} />
    <button className="text-button preview-record-link" onClick={() => onSelect(record.entity.id)}>Open record →</button>
  </details>)}</section>;
}

export function RecordPreview({ entity, entities, send, onSelect }: { entity: Entity; entities: Entity[]; send: Send; onSelect: (id: string) => void }) {
  const related = relatedRecords(entity, entities);
  const { preview, loading, error, reload } = useEntityPreview(entity, related, send);
  const reported = resultSections(entity.body);
  const [tab, setTab] = useState<'review' | 'setup' | 'results'>('review');
  const records = preview?.records || [entity, ...related].map(item => ({ entity: item, sources: [] } as PreviewRecord));
  const own = records.find(record => record.entity.id === entity.id);
  const evidence = records.filter(record => record.entity.id !== entity.id);
  const sources = records.flatMap(record => record.sources.map(source => ({ ...source, group: [source.group, record.entity.title].filter(Boolean).join(' · '), ...(record.entity.status === 'Invalid' ? { message: ['Invalid evidence.', record.entity.metadata.invalidationReason, source.message].filter(Boolean).join(' ') } : {}) }))).filter((source, i, all) => all.findIndex(other => sourceKey(other) === sourceKey(source)) === i);
  const figures = sources.filter(source => source.kind === 'image' && (entity.kind !== 'Experiment' || !isSetup(source)));
  const tables = sources.filter(source => source.kind === 'table' && (entity.kind !== 'Experiment' || !isSetup(source)));
  const setup = sources.filter(isSetup);
  const remaining = sources.filter(source => !isSetup(source) && source.kind !== 'image' && source.kind !== 'table');
  const observations = observationOrder(evidence.filter(record => record.entity.metadata.role === 'Observation'));
  const interpretations = evidence.filter(record => record.entity.metadata.role === 'Interpretation');
  const artifacts = evidence.filter(record => record.entity.kind === 'Artifact');
  const otherNotes = evidence.filter(record => record.entity.kind === 'Note' && !['Observation', 'Interpretation'].includes(record.entity.metadata.role));
  const resultCount = artifacts.length + observations.length;
  const body = <MarkdownText text={entity.body || 'No description yet.'} images={own?.images} documentPath={entity.filePath} send={send} />;
  const previewStatus = <div className="preview-status"><span className="quiet" role="status">{loading ? 'Loading file previews…' : error ? 'File preview unavailable' : 'Files read from linked sources'}</span><button className="text-button" aria-label="Reload previews" onClick={reload} disabled={loading}>Reload</button></div>;
  if (entity.kind !== 'Experiment') return <><div className="detail-block"><h3>{entity.kind === 'Claim' ? 'Claim and context' : 'Description'}</h3>{body}</div>{(sources.length > 0 || loading || error) && <details className="detail-block"><summary>File previews</summary>{previewStatus}{error && <p className="form-error">{error}</p>}<Files sources={[...figures, ...tables, ...sources.filter(source => source.kind !== 'image' && source.kind !== 'table')]} send={send} /></details>}</>;
  return <div className="experiment-preview">
    <div className="experiment-tabs" role="tablist" aria-label="Experiment details">{(['review', 'setup', 'results'] as const).map(value => <button key={value} role="tab" id={`tab-${value}`} aria-controls={`panel-${value}`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={event => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const tabs = ['review', 'setup', 'results'] as const; const next = event.key === 'Home' ? 'review' : event.key === 'End' ? 'results' : tabs[(tabs.indexOf(value) + (event.key === 'ArrowRight' ? 1 : 2)) % 3]; setTab(next); document.getElementById(`tab-${next}`)?.focus(); }
    }}>{value === 'review' ? 'Review' : value === 'setup' ? 'Setup' : `Results${resultCount ? ` · ${resultCount}` : ''}`}</button>)}</div>
    {tab !== 'review' && <>{previewStatus}{error && <p className="form-error" role="alert">{error}</p>}</>}
    {tab !== 'review' && preview?.truncated && <p className="notice subtle">Preview limit reached. Open the linked files and records for the complete evidence.</p>}
    {tab === 'review' ? <Review entity={entity} records={records} entities={entities} send={send} onSelect={onSelect} openResults={() => { setTab('results'); document.getElementById('tab-results')?.focus(); }} /> : tab === 'setup' ? <section className="experiment-tab-panel" role="tabpanel" id="panel-setup" aria-labelledby="tab-setup"><h3>Experiment brief</h3>{body}{setup.length > 0 && <section className="preview-section"><h3>Configuration</h3><Files sources={setup} send={send} /></section>}</section> : <section className="experiment-tab-panel" role="tabpanel" id="panel-results" aria-labelledby="tab-results">
      {(!resultCount && !reported && !figures.length && !tables.length) && <p className="notice subtle">No linked results yet. Link an Artifact or Observation to this experiment to show its evidence here.</p>}
      {artifacts.some(record => record.entity.status === 'Invalid') && <p className="notice">Some linked evidence is invalid. Its files remain available for traceability; check the evidence records below.</p>}
      {reported && !observations.length && <details className="preview-more reported-results"><summary>Recorded outcome and completion</summary><MarkdownText text={reported} images={own?.images} documentPath={entity.filePath} send={send} /></details>}
      <RecordNotes title="Observations" records={observations} send={send} onSelect={onSelect} initiallyOpen />
      <RecordNotes title="Interpretations" records={interpretations} send={send} onSelect={onSelect} />
      {figures.length > 0 && <section className="preview-section"><h3>Figures <span className="quiet">{figures.length}</span></h3><Files sources={figures.slice(0, 3)} send={send} />{figures.length > 3 && <details className="preview-more"><summary>More figures · {figures.length - 3}</summary><Files sources={figures.slice(3)} send={send} /></details>}</section>}
      {tables.length > 0 && <section className="preview-section"><h3>Tables <span className="quiet">{tables.length}</span></h3><Files sources={tables} send={send} expandedLimit={0} /></section>}
      <RecordNotes title="Evidence records" records={artifacts} send={send} onSelect={onSelect} />
      <RecordNotes title="Other notes" records={otherNotes} send={send} onSelect={onSelect} />
      {remaining.length > 0 && <section className="preview-section"><h3>Other files</h3><Files sources={remaining} send={send} /></section>}
    </section>}
  </div>;
}
