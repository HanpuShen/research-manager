import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Entity, EntityKind, GraphNode, SourceRef } from '../src/types.js';
import { statusTone } from './Graph.js';
import { backBurnerCategories, canBackBurner, isBackBurner } from '../src/workflow.js';
import { InlineMath, MarkdownText } from './Markdown.js';
import { RecordPreview } from './ExperimentPreview.js';
import { PaperDetails } from './RelatedWork.js';
import { paperStatuses } from '../src/types.js';
export { MarkdownText } from './Markdown.js';

export type Send = (command: string, payload?: any) => void;

export function SourceLinks({ sources, send }: { sources: SourceRef[]; send: Send }) {
  return <div className="source-links">{sources.map((source, index) => <button key={index} className="source-link" onClick={() => send('openSource', { source })} title={source.path || source.url}>
    <span aria-hidden="true">↗</span><span>{source.label || source.symbol || source.path?.split('/').pop() || source.url}{source.line ? `:${source.line}` : ''}</span>
  </button>)}</div>;
}

export function Details({ entity, node, entities, send, onClose, onEdit, onSelect, onBack, backTitle, initialScroll = 0 }: { entity?: Entity; node?: GraphNode; entities: Entity[]; send: Send; onClose: () => void; onEdit: (entity: Entity) => void; onSelect: (id: string) => void; onBack?: () => void; backTitle?: string; initialScroll?: number }) {
  const panel = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { if (panel.current) panel.current.scrollTop = initialScroll; }, []);
  const [action, setAction] = useState<'review' | 'invalidate' | 'link' | 'park' | ''>('');
  const [status, setStatus] = useState(entity?.status || 'Open');
  const [reason, setReason] = useState('');
  const [category, setCategory] = useState('');
  const [supersededBy, setSupersededBy] = useState('');
  const [targetId, setTargetId] = useState('');
  const [relation, setRelation] = useState('related');
  const [actionBase, setActionBase] = useState<Entity | undefined>(entity);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [placementNotice, setPlacementNotice] = useState('');
  const placementRequest = useRef<'park' | 'restore' | null>(null);
  const [placementFocus, setPlacementFocus] = useState<'park' | 'restore' | null>(null);
  const parked = !!entity && isBackBurner(entity);
  const placement = entity?.metadata.backBurner;
  const proposal = entity?.kind === 'Claim' ? entities.filter(other => other.kind === 'Note' && other.status === 'Proposed' && other.links.some(link => link.target === entity.id && link.relation === 'proposes')).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] : undefined;
  useLayoutEffect(() => {
    if (!placementFocus || pending || (placementFocus === 'restore') !== parked) return;
    panel.current?.querySelector<HTMLElement>(`[data-${placementFocus}]`)?.focus({ preventScroll: true });
    setPlacementFocus(null);
  }, [placementFocus, parked, pending]);
  const beginAction = (next: typeof action) => { setAction(action === next ? '' : next); setActionBase(entity); setError(''); };
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.data?.type === 'saved' && event.data.id === entity?.id) {
        const moved = placementRequest.current;
        if (moved) setPlacementNotice(moved === 'park' ? 'Moved to Back burner. You can restore it at any time.' : 'Restored to current.');
        setAction(''); setPending(false); setReason(''); placementRequest.current = null;
        if (moved) setPlacementFocus(moved === 'park' ? 'restore' : 'park');
      }
      if (event.data?.type === 'error' && pending) { setError(event.data.message); setPending(false); }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [entity?.id, pending, action]);
  const currentStatus = entity?.metadata.needsReview ? 'Needs review' : entity?.status || node?.status;
  const conditions = entity?.metadata.conditions ?? entity?.metadata.scope;
  const relationships = entity ? entities.flatMap(other => {
    if (other.id === entity.id) return [];
    const outgoing = entity.links.filter(link => link.target === other.id).map(link => `${link.relation.replaceAll('_', ' ')} →`);
    const incoming = other.links.filter(link => link.target === entity.id).map(link => `← ${link.relation.replaceAll('_', ' ')}`);
    const relations = [...new Set([...outgoing, ...incoming])];
    return relations.length ? [{ other, relation: relations.join(' · ') }] : [];
  }).sort((a, b) => ["Claim","Experiment","Artifact","Note","Paper","Idea","Project"].indexOf(a.other.kind) - ["Claim","Experiment","Artifact","Note","Paper","Idea","Project"].indexOf(b.other.kind)) : [];
  return <aside ref={panel} className={`details-panel ${entity?.kind === 'Experiment' || entity?.kind === 'Artifact' || entity?.kind === 'Claim' ? 'details-rich' : ''} ${expanded ? 'details-expanded' : ''}`} aria-label="Selected record">
    <div className="details-heading">{onBack ? <button className="text-button detail-back" aria-label="Back to previous record" title={`Back to ${backTitle || 'previous record'}`} onClick={onBack}>← Back</button> : <span className="eyebrow">{entity?.kind || node?.kind || 'Code'}</span>}<div className="details-window-actions"><button className="icon-button" aria-label={expanded ? 'Collapse details' : 'Expand details'} title={expanded ? 'Collapse details' : 'Expand details'} onClick={() => setExpanded(value => !value)}>{expanded ? '↙' : '↗'}</button><button className="icon-button" aria-label="Close details" onClick={onClose}>×</button></div></div>
    {onBack && <div className="eyebrow detail-kind">{entity?.kind || node?.kind || 'Code'}</div>}
    <h2 tabIndex={-1}>{entity?.title || node?.label}</h2>
    {node?.source?.path && <p className="source-location"><code>{node.source.path.split('/').pop()}{node.source.line ? `:${node.source.line}` : ''}</code></p>}
    <div className="detail-badges">{parked && <span className="badge">Back burner</span>}{entity?.kind === 'Claim' && <span className={`badge ${statusTone(entity.status)}`}>{entity.status}</span>}{currentStatus && currentStatus !== 'Parked' && (entity?.kind !== 'Claim' || currentStatus !== entity.status) && <span className={`badge ${statusTone(currentStatus)}`}><span className={`status-dot ${statusTone(currentStatus)}`} />{currentStatus}</span>}{entity?.kind === 'Experiment' && <span className="badge">{String(entity.metadata.experimentType || entity.metadata.mode || 'Exploration').replace(/^./, text => text.toUpperCase())}</span>}</div>
    {entity?.kind === 'Claim' && entity.metadata.answer && <p className="claim-answer"><InlineMath text={String(entity.metadata.answer)} /></p>}
    {entity?.kind === 'Claim' && entity.metadata.reportedVerdict && <p className="judgment-summary quiet">Source reports: <strong>{String(entity.metadata.reportedVerdict)}</strong> · your judgment is the badge above</p>}
    {entity?.kind === 'Claim' && !entity.metadata.review && <p className="judgment-summary quiet">No confirmed judgment recorded.</p>}
    {proposal && <div className="placement-note"><strong>Agent proposes: {String(proposal.metadata.proposedStatus)} · not confirmed</strong><MarkdownText text={proposal.body} documentPath={proposal.filePath} send={send} /><button className="text-button" onClick={() => onSelect(proposal.id)}>Open proposal note →</button></div>}
    {entity?.kind === 'Claim' && entity.metadata.proposedStatus && entity.metadata.proposedStatus !== entity.metadata.review?.status && <p className="judgment-summary quiet">Agent suggestion: {String(entity.metadata.proposedStatus)} · Not confirmed</p>}
    {entity?.metadata.imported && <p className="notice subtle">Imported from existing records. Links and interpretations need your review.</p>}
    {!!conditions && <div className="detail-scope"><h3>Applies to</h3><p>{String(conditions)}</p></div>}
    {!!entity?.metadata.needsReview && <p className="notice">{String(entity.metadata.reviewReason || 'This record needs your review. Check the evidence and its limits before citing it.')}</p>}
    {parked && <div className="placement-note"><strong>Moved to back burner{placement?.category ? ` · ${placement.category}` : ''}</strong><p>{placement?.reason || 'No reason recorded.'}</p>{placement?.supersededBy && <p><button className="text-button" onClick={() => onSelect(placement.supersededBy)}>Superseded by {entities.find(other => other.id === placement.supersededBy)?.title || placement.supersededBy} →</button></p>}{placement?.at && <small className="quiet">{new Date(placement.at).toLocaleString()}</small>}</div>}
    {placementNotice && <p className="quiet placement-feedback" role="status">{placementNotice}</p>}
    <div className="detail-actions">
      {entity && <><button onClick={() => onEdit(entity)}>Edit record</button><button onClick={() => send('openEntity', { id: entity.id })}>Open notes ↗</button></>}
      {entity && canBackBurner(entity) && (parked ? <button data-restore className="primary" disabled={pending} onClick={() => { setPending(true); setError(''); setPlacementNotice(''); placementRequest.current = 'restore'; send('setBackBurner', { id: entity.id, active: false, expectedRevision: entity.revision, expectedHash: entity.contentHash }); }}>Restore to current</button> : <button data-park disabled={pending} onClick={() => { setReason(''); setPlacementNotice(''); beginAction('park'); }}>Move to back burner</button>)}
      {node?.source && <button className="primary" onClick={() => send('openSource', { source: node.source })}>Open code ↗</button>}
    </div>
    {error && !action && <p className="form-error" role="alert">{error}</p>}
    {action === 'park' && entity && <form className="inline-form placement-form" onSubmit={event => {
      event.preventDefault();
      if (!actionBase || pending) return;
      setPending(true); setError('');
      placementRequest.current = 'park';
      send('setBackBurner', { id: entity.id, active: true, reason, category: category || undefined, supersededBy: category === 'superseded' ? supersededBy : undefined, expectedRevision: actionBase.revision, expectedHash: actionBase.contentHash });
    }}>
      <label>Reason (optional)<textarea aria-label="Back burner reason" autoFocus rows={2} value={reason} onChange={event => setReason(event.target.value)} placeholder="Lower priority, replaced by another approach…" /></label>
      <label>Category<select aria-label="Back burner category" value={category} onChange={event => setCategory(event.target.value)}><option value="">Not set</option>{backBurnerCategories.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      {category === 'superseded' && <label>Replaced by<select aria-label="Replaced by" required value={supersededBy} onChange={event => setSupersededBy(event.target.value)}><option value="">Choose a record</option>{entities.filter(other => other.id !== entity.id && other.kind === entity.kind).map(other => <option key={other.id} value={other.id}>{other.title}</option>)}</select></label>}
      <p className="quiet">This moves the record out of the current collection. Its notes, results, and connections stay available.</p>
      {entity.projectIds.length > 1 && <p className="notice subtle">Shared across {entity.projectIds.length} projects. This move applies to all of them.</p>}
      {entity.kind === 'Experiment' && <p className="quiet">Running jobs keep running. If results are invalid, mark the linked evidence invalid separately.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions"><button type="button" disabled={pending} onClick={() => { setAction(''); setPlacementFocus('park'); }}>Cancel</button><button className="primary" disabled={pending} type="submit">{pending ? 'Saving…' : 'Move to back burner'}</button></div>
    </form>}
    {!parked && placement?.restoredAt && <details className="placement-history"><summary>Previous back burner move</summary><p>{placement.reason || 'No reason recorded.'}</p><small className="quiet">Moved {new Date(placement.at).toLocaleString()} · Restored {new Date(placement.restoredAt).toLocaleString()}</small></details>}
    {entity?.kind === 'Paper' ? <PaperDetails paper={entity} send={send} /> : entity ? <RecordPreview entity={entity} entities={entities} send={send} onSelect={onSelect} /> : <div className="detail-block"><h3>Description</h3><MarkdownText text={node?.description || 'No description yet.'} send={send} /></div>}
    {node?.source && <details className="source-provenance"><summary>Source details</summary><dl><dt>File</dt><dd><code>{node.source.path}</code></dd>{node.source.symbol && <><dt>Symbol</dt><dd><code>{node.source.symbol}</code></dd></>}{node.source.revision && <><dt>Source revision</dt><dd><code>{node.source.revision}</code></dd></>}{node.source.reviewedHash && <><dt>Reviewed file hash</dt><dd><code>{node.source.reviewedHash}</code></dd></>}</dl><p className="quiet">Source revision identifies the current code. The reviewed file hash identifies the version used for this explanation.</p></details>}
    {!!entity?.sources.length && <div className="detail-block"><h3>Sources</h3><SourceLinks sources={entity.sources} send={send} /></div>}
    {entity && <div className="detail-block"><div className="block-heading"><h3>Connections</h3><button className="text-button" onClick={() => beginAction('link')}>Add link</button></div>
      {relationships.length ? relationships.map(({ other, relation: rel }, index) => <button key={`${other.id}:${index}`} className="related-record" onClick={() => onSelect(other.id)}><span>{other.title}</span><small>{rel.replaceAll('_', ' ')} · {other.kind}{isBackBurner(other) ? ' · Back burner' : ''}</small></button>) : <p className="quiet">No linked records yet.</p>}
    </div>}
    {entity?.kind === 'Claim' && <div className="detail-block"><h3>Your judgment</h3>{entity.metadata.review && <div className="review-record"><span className={`badge ${statusTone(entity.metadata.review.status)}`}>{String(entity.metadata.review.status)}</span><MarkdownText text={String(entity.metadata.review.reason || '')} documentPath={entity.filePath} send={send} />{entity.metadata.review.at && <small className="quiet">Confirmed {new Date(entity.metadata.review.at).toLocaleString()}</small>}</div>}<p className="quiet">Agent suggestions remain in the notes until you confirm a judgment.</p><button onClick={() => { setStatus(['Open', 'Supported', 'Mixed', 'Refuted'].includes(proposal?.metadata.proposedStatus) ? proposal!.metadata.proposedStatus : ['Open', 'Supported', 'Mixed', 'Refuted'].includes(entity.status) ? entity.status : 'Open'); beginAction('review'); }}>Review claim</button></div>}
    {entity?.kind === 'Artifact' && <div className="detail-block"><h3>Evidence validity</h3>{entity.status === 'Invalid' ? <p className="notice">This evidence is invalid. {String(entity.metadata.invalidationReason || '')}</p> : <button onClick={() => beginAction('invalidate')}>Mark evidence invalid</button>}</div>}
    {action && action !== 'park' && entity && <form className="inline-form" onSubmit={event => {
      event.preventDefault();
      if (!actionBase || pending) return;
      setPending(true); setError('');
      const expected = { expectedRevision: actionBase.revision, expectedHash: actionBase.contentHash };
      if (action === 'review') send('reviewClaim', { id: entity.id, ...expected, status, reason });
      if (action === 'invalidate') send('invalidateArtifact', { id: entity.id, ...expected, reason });
      if (action === 'link') send('saveEntity', { entity: { ...actionBase, links: [...actionBase.links, { target: targetId, relation }] }, ...expected });
    }}>
      {action === 'review' && <label>Claim status<select aria-label="Claim status" value={status} onChange={event => setStatus(event.target.value)}>{['Open', 'Supported', 'Mixed', 'Refuted'].map(value => <option key={value}>{value}</option>)}</select></label>}
      {action !== 'link' && <label>{action === 'review' ? 'Reason for your judgment' : 'Why is this evidence invalid?'}<textarea aria-label={action === 'review' ? 'Reason for your judgment' : 'Why is this evidence invalid?'} required rows={3} value={reason} onChange={event => setReason(event.target.value)} placeholder="Describe the evidence and its limits." /></label>}
      {action === 'link' && <><label>Record<select aria-label="Record" required value={targetId} onChange={event => setTargetId(event.target.value)}><option value="">Choose a record</option>{entities.filter(other => other.id !== entity.id).map(other => <option key={other.id} value={other.id}>{other.kind}: {other.title}</option>)}</select></label><label>Relationship<select aria-label="Relationship" value={relation} onChange={event => setRelation(event.target.value)}>{['related', 'supports', 'refutes', 'tests', 'subclaim_of', 'motivates', 'produces', 'supersedes', 'builds_on', 'baseline', 'compares_with', 'cites'].map(value => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></label></>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions"><button type="button" disabled={pending} onClick={() => setAction('')}>Cancel</button><button className="primary" disabled={pending} type="submit">{pending ? 'Saving…' : action === 'review' ? 'Confirm judgment' : action === 'invalidate' ? 'Invalidate evidence' : 'Save link'}</button></div>
    </form>}
    {entity && <footer className="record-footer"><code>{entity.id}</code><span>Revision {entity.revision} · Updated {new Date(entity.updatedAt).toLocaleString()}</span><span>{entity.projectIds.length} linked project{entity.projectIds.length === 1 ? '' : 's'}</span></footer>}
  </aside>;
}

const experimentTemplates: Record<string, string> = {
  exploration: '## Question\n\n## Setup\n\n## Planned readouts\n',
  validation: '## Claim\n\n## Setup\n\n## Controls\n\n## Parameter selection\n\n## Judgment criteria\n',
};
const templates: Record<string, string> = {
  Idea: '## Question\n\n## Why it matters\n\n## Next step\n',
  Claim: '## Claim\n\n## Conditions\n\n## Evidence needed\n\n## Agent suggestions\n',
  Experiment: experimentTemplates.exploration,
  Note: '## Observation\n\n## Interpretation\n\n## Next step\n',
};
export function EntityEditor({ entity, kind, projects, projectId, entities, send, onClose }: { entity?: Entity; kind: EntityKind; projects: Entity[]; projectId: string; entities: Entity[]; send: Send; onClose: () => void }) {
  const [title, setTitle] = useState(entity?.title || '');
  const [body, setBody] = useState(entity?.body || templates[kind] || '');
  const [projectIds, setProjectIds] = useState<string[]>(entity?.projectIds || (projectId ? [projectId] : []));
  const [status, setStatus] = useState(entity?.status || 'Open');
  const [experimentType, setExperimentType] = useState(String(entity?.metadata.experimentType || entity?.metadata.mode || 'exploration').toLowerCase());
  const [conditions, setConditions] = useState(String(entity?.metadata.conditions ?? entity?.metadata.scope ?? ''));
  const [target, setTarget] = useState('');
  const [mergeTarget, setMergeTarget] = useState(String(entity?.metadata.mergedInto || ''));
  const m = entity?.metadata || {};
  const [authors, setAuthors] = useState((m.authors || []).join('; '));
  const [year, setYear] = useState(m.year ? String(m.year) : '');
  const [venue, setVenue] = useState(String(m.venue || ''));
  const [paperUrl, setPaperUrl] = useState(String(m.paperUrl || ''));
  const [codeUrls, setCodeUrls] = useState((m.code || []).map((c: any) => c.url).join('\n'));
  const [tags, setTags] = useState((m.tags || []).join(', '));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.data?.type === 'saved' && pending) onClose();
      if (event.data?.type === 'error' && pending) { setError(event.data.message); setPending(false); }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [pending, onClose]);
  return <div className="modal-backdrop"><section className="editor-dialog" role="dialog" aria-modal="true" aria-labelledby="editor-title" onKeyDown={event => {
    if (event.key === 'Escape' && !pending) onClose();
    if (event.key === 'Tab') {
      const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)'));
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <div className="dialog-heading"><h2 id="editor-title">{entity ? 'Edit' : 'New'} {kind.toLowerCase()}</h2><button className="icon-button" disabled={pending} aria-label="Close editor" onClick={onClose}>×</button></div>
    <form onSubmit={event => {
      event.preventDefault();
      if (pending) return;
      setPending(true); setError('');
      const links = [...(entity?.links || [])];
      if (target) links.push({ target, relation: kind === 'Experiment' ? entities.find(item => item.id === target)?.kind === 'Idea' ? 'explores' : 'tests' : 'related' });
      if (kind === 'Idea' && status === 'Merged' && mergeTarget && !links.some(link => link.target === mergeTarget && link.relation === 'merged_into')) links.push({ target: mergeTarget, relation: 'merged_into' });
      const paper = kind === 'Paper' ? (() => {
        const urls = codeUrls.split(/\s+/).filter(Boolean);
        const linkChanged = paperUrl.trim() !== String(m.paperUrl || '');
        return { authors: authors.split(';').map((a: string) => a.trim()).filter(Boolean), year: year.trim() ? Number(year) : undefined, venue: venue.trim() || undefined,
          paperUrl: paperUrl.trim() || undefined, code: urls.map((url: string) => (m.code || []).find((c: any) => c.url === url) || { url }),
          tags: tags.split(',').map((t: string) => t.trim()).filter(Boolean), ...(linkChanged ? { arxivId: null, pdfUrl: null, fetchedFrom: null } : {}) };
      })() : {};
      send('saveEntity', { entity: { ...entity, kind, title: title.trim(), body, projectIds, status, links, sources: entity?.sources || [], metadata: { ...entity?.metadata, ...paper, ...(kind === 'Experiment' ? { experimentType } : {}), ...(kind === 'Claim' ? { conditions } : {}), ...(kind === 'Idea' && status === 'Merged' ? { mergedInto: mergeTarget } : {}) } }, ...(entity ? { expectedRevision: entity.revision, expectedHash: entity.contentHash } : {}) });
    }}>
      <label>Title<input aria-label="Title" autoFocus required value={title} onChange={event => setTitle(event.target.value)} placeholder={kind === 'Experiment' ? 'What will this comparison tell us?' : 'A clear, short title'} /></label>
      {kind === 'Paper' ? <p className="quiet">Stored in {projects.find(project => project.id === projectIds[0])?.title || projectIds[0]} only. Papers are kept per project.</p> : <fieldset><legend>Projects</legend><div className="project-checks">{projects.map(project => <label className="check-label" key={project.id}><input type="checkbox" checked={projectIds.includes(project.id)} onChange={event => setProjectIds(ids => event.target.checked ? [...ids, project.id] : ids.filter(id => id !== project.id))} />{project.title}</label>)}</div>{!projectIds.length && <small className="quiet">This record will be available globally.</small>}</fieldset>}
      {kind === 'Paper' && <>
        <label>Reading status<select aria-label="Reading status" value={status} onChange={event => setStatus(event.target.value)}>{paperStatuses.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Authors <span className="quiet">separated by ;</span><input aria-label="Authors" value={authors} onChange={event => setAuthors(event.target.value)} /></label>
        <label>Year<input aria-label="Year" inputMode="numeric" pattern="\d{4}" value={year} onChange={event => setYear(event.target.value)} /></label>
        <label>Venue<input aria-label="Venue" value={venue} onChange={event => setVenue(event.target.value)} placeholder="NeurIPS 2025, arXiv" /></label>
        <label>Paper link<input aria-label="Paper link" type="url" value={paperUrl} onChange={event => setPaperUrl(event.target.value)} /></label>
        <label>Code repositories <span className="quiet">one per line</span><textarea aria-label="Code repositories" rows={2} value={codeUrls} onChange={event => setCodeUrls(event.target.value)} /></label>
        <label>Tags <span className="quiet">comma separated</span><input aria-label="Tags" value={tags} onChange={event => setTags(event.target.value)} /></label>
      </>}
      {kind === 'Idea' && <label>Status<select aria-label="Status" value={status} onChange={event => setStatus(event.target.value)}>{[...new Set([status, 'Open', 'Active', 'Merged'])].map(value => <option key={value}>{value}</option>)}</select></label>}
      {kind === 'Idea' && status === 'Merged' && <label>Merge into<select aria-label="Merge into" required value={mergeTarget} onChange={event => setMergeTarget(event.target.value)}><option value="">Choose an idea</option>{entities.filter(other => other.kind === 'Idea' && other.id !== entity?.id && other.status !== 'Merged').map(other => <option key={other.id} value={other.id}>{other.title}</option>)}</select><small className="quiet">Both records stay available, with a link to the combined idea.</small></label>}
      {kind === 'Experiment' && <label>Experiment type<select aria-label="Experiment type" value={experimentType} onChange={event => { const next = event.target.value; if (!entity && (body === experimentTemplates[experimentType] || !body.trim())) setBody(experimentTemplates[next]); setExperimentType(next); }}><option value="exploration">Exploration</option><option value="validation">Validation</option></select><small className="quiet">{experimentType === 'exploration' ? 'Write down the question, setup, and what you want to observe.' : 'Specify the claim, controls, parameter selection, and judgment criteria before running.'}</small></label>}
      {kind === 'Claim' && <label>Applies to<input aria-label="Applies to" value={conditions} onChange={event => setConditions(event.target.value)} placeholder="Environment, assumptions, or limits" /></label>}
      {!entity && <label>Link to a record<select aria-label="Link to a record" value={target} onChange={event => setTarget(event.target.value)}><option value="">No link yet</option>{entities.filter(other => other.kind !== 'Project').map(other => <option key={other.id} value={other.id}>{other.kind}: {other.title}</option>)}</select></label>}
      <label>Notes <span className="quiet">Markdown</span><textarea aria-label="Notes Markdown" className="notes-input" required={kind !== 'Paper'} rows={kind === 'Paper' ? 6 : 12} value={body} onChange={event => setBody(event.target.value)} /></label>
      {entity && <p className="quiet">Saving against revision {entity.revision}. Conflicting changes will be reported.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions"><button type="button" disabled={pending} onClick={onClose}>Cancel</button><button className="primary" disabled={pending} type="submit">{pending ? 'Saving…' : `Save ${kind.toLowerCase()}`}</button></div>
    </form>
  </section></div>;
}
