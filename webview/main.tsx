import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { navigationCommands, type AppState, type Entity, type EntityKind, type Section } from '../src/types.js';
import { isBackBurner, primaryHandoff } from '../src/workflow.js';
import { ResearchMap, researchMap, statusTone } from './Graph.js';
import { Details, EntityEditor, type Send } from './EntityDetails.js';
import { AddPaperDialog, RelatedWork } from './RelatedWork.js';
import { OverviewArgument, argumentOf, projectSummary } from './Overview.js';
import { ResearchHealth } from './Health.js';
import { InlineMath } from './Markdown.js';
import '@xyflow/react/dist/style.css';
import 'katex/dist/katex.min.css';
import './styles.css';

declare global { interface Window { acquireVsCodeApi?: () => { postMessage: (message: unknown) => void; setState: (state: unknown) => void; getState: () => any } } }
const vscode = window.acquireVsCodeApi?.();
const sections: Section[] = ['Overview', 'Ideas', 'Experiments', 'Related work', 'Source Code', 'Report', 'Files'];
const sectionIcons: Record<Section, string> = { Overview: '◈', Ideas: '◇', Experiments: '⌘', 'Related work': '❝', 'Source Code': '⌥', Report: '▤', Files: '▱' };
const emptyState: AppState = { projects: [], entities: [], selectedProjectId: '', section: 'Overview', errors: [], loading: true };

function nextStep(body = '') {
  const section = body.match(/^#{1,6}\s+(?:Open\s+)?Next(?:\s+steps?)?[^\n]*\n([\s\S]*?)(?=^#{1,6}\s|$)/im)?.[1];
  return section?.trim().split(/\n\s*\n/)[0].replace(/^[-*]\s+/gm, '').replace(/\n/g, ' ').trim() || '';
}

function useBridge() {
  const [state, setState] = useState<AppState>(emptyState);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const clientId = useRef(crypto.randomUUID());
  const selectedProjectId = useRef('');
  const pendingNavigation = useRef<string | null>(null);
  const latestNavigation = useRef<string | null>(null);
  const navigationRevision = useRef(0);
  const receiveState = useCallback((message: any) => {
    const incoming = message.state || (message.projects ? message : undefined);
    if (!incoming) return;
    const revision = message.navigationRevision ?? navigationRevision.current;
    if (revision < navigationRevision.current) return;
    if (message.navigationRequestId && message.navigationRequestId !== latestNavigation.current) return;
    if (pendingNavigation.current && !message.externalNavigation && message.requestId !== pendingNavigation.current) return;
    navigationRevision.current = revision;
    pendingNavigation.current = null;
    if (message.externalNavigation) latestNavigation.current = null;
    selectedProjectId.current = incoming.selectedProjectId;
    setState(incoming);
  }, []);
  const send = useCallback<Send>((command, payload = {}) => {
    if (command !== 'previewEntity') setError('');
    const requestId = String(++sequence.current);
    payload = { contextProjectId: selectedProjectId.current, ...payload };
    const message = { command, payload, requestId, clientId: clientId.current, sequence: sequence.current };
    if (navigationCommands.has(command)) {
      pendingNavigation.current = requestId;
      latestNavigation.current = requestId;
      if (command === 'selectSection') setState(current => ({ ...current, section: payload.section, loading: payload.section === 'Source Code' && !current.graph }));
    }
    if (vscode) { vscode.postMessage(message); return; }
    const perform = async () => {
      const response = await fetch(command === 'ready' ? `/api/state?requestId=${requestId}` : '/api/command', command === 'ready' ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || data.message || `Request failed (${response.status})`);
      if (command === 'previewEntity') { window.dispatchEvent(new MessageEvent('message', { data })); return; }
      receiveState(data);
      if (data.savedId) window.dispatchEvent(new MessageEvent('message', { data: { type: 'saved', id: data.savedId } }));
    };
    void perform().catch(cause => {
      if (command === 'previewEntity') {
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'entityPreview', entityId: payload.id, token: payload.token, error: cause.message } })); return;
      }
      if (navigationCommands.has(command) && latestNavigation.current !== requestId) return;
      if (pendingNavigation.current === requestId) pendingNavigation.current = null;
      setError(cause.message); setState(current => ({ ...current, loading: false }));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'error', message: cause.message } }));
    });
  }, [receiveState]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.data?.type === 'state') receiveState(event.data);
      if (event.data?.type === 'error') {
        if (event.data.navigationRevision !== undefined && event.data.navigationRevision < navigationRevision.current) return;
        if (event.data.requestId === pendingNavigation.current) pendingNavigation.current = null;
        setError(event.data.message); setState(current => ({ ...current, loading: false }));
      }
    };
    window.addEventListener('message', receive);
    send('ready');
    return () => window.removeEventListener('message', receive);
  }, [send, receiveState]);
  return { state, send, error, dismissError: () => setError('') };
}

function Empty({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return <div className="empty-state"><span className="empty-icon" aria-hidden="true">◇</span><h2>{title}</h2><p>{children}</p>{action}</div>;
}

function snippet(record: Entity, limit = 180) {
  if (record.kind === 'Claim' && record.metadata.answer) return String(record.metadata.answer);
  const text = record.body.split(/\n\s*\n/).map(part => part.split('\n').filter(line => !/^\s*(#|\||[-*]\s*$)/.test(line)).join(' ').trim()).find(Boolean) || '';
  const plain = text.replace(/[*_`]/g, '').replace(/\s+/g, ' ');
  return plain.length <= limit ? plain : plain.slice(0, plain.lastIndexOf(' ', limit)).replace(/[,;:.]$/, '') + '…';
}

function RecordCards({ records, projects, onSelect }: { records: Entity[]; projects: Entity[]; onSelect: (id: string) => void }) {
  return <div className="idea-grid">{records.map(record => <button className="idea-card" key={record.id} onClick={() => onSelect(record.id)}>
    <div className="idea-card-top"><span className={`badge ${statusTone(record.status)}`}>{record.status === 'Parked' ? 'Back burner' : record.status}</span><span className="quiet">↗</span></div>
    <h3>{record.title}</h3><p>{isBackBurner(record) ? record.metadata.backBurner?.reason || 'No reason recorded.' : snippet(record)}</p>
    {isBackBurner(record) && record.metadata.backBurner?.at && <small className="quiet">{record.metadata.backBurner.category ? `${record.metadata.backBurner.category} · ` : ''}Moved {new Date(record.metadata.backBurner.at).toLocaleDateString()}</small>}
    <footer>{record.projectIds.length ? record.projectIds.map(id => projects.find(project => project.id === id)?.title || id).join(' · ') : 'Global idea'}</footer>
  </button>)}</div>;
}

function Ideas({ state, query, view, setView, scope, setScope, onSelect, onCreate }: { state: AppState; query: string; view: string; setView: (view: string) => void; scope: string; setScope: (scope: string) => void; onSelect: (id: string) => void; onCreate: () => void }) {
  const [status, setStatus] = useState('all');
  useEffect(() => setStatus('all'), [view]);
  const scoped = state.entities.filter(entity => entity.kind === 'Idea' && (scope === 'all' || entity.projectIds.includes(state.selectedProjectId)));
  const matches = (entity: Entity) => `${entity.title} ${entity.body} ${entity.metadata.backBurner?.reason || ''}`.toLowerCase().includes(query.toLowerCase());
  const ideas = scoped.filter(entity => isBackBurner(entity) === (view === 'back-burner') && (status === 'all' || entity.status === status) && matches(entity));
  const hiddenMatches = scoped.filter(entity => isBackBurner(entity) && matches(entity)).length;
  return <section className="content-list"><div className="list-toolbar"><div className="segmented" aria-label="Idea scope"><button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>All projects</button><button className={scope === 'project' ? 'active' : ''} onClick={() => setScope('project')}>This project</button></div>{view !== 'back-burner' && <label className="compact-label">Status<select value={status} onChange={event => setStatus(event.target.value)}>{['all', ...new Set(scoped.filter(entity => !isBackBurner(entity)).map(entity => entity.status)), 'Open', 'Active', 'Merged'].filter((value, index, values) => values.indexOf(value) === index).map(value => <option key={value} value={value}>{value === 'all' ? 'Any status' : value}</option>)}</select></label>}<span className="quiet">{ideas.length} ideas</span></div>
    {view === 'back-burner' && <p className="collection-note">Set aside for later. Open a record to restore it to Current.</p>}
    {query && view !== 'back-burner' && hiddenMatches > 0 && <p className="collection-note"><button className="text-button" onClick={() => setView('back-burner')}>{hiddenMatches} matching {hiddenMatches === 1 ? 'idea' : 'ideas'} in Back burner →</button></p>}
    {ideas.length ? <RecordCards records={ideas} projects={state.projects} onSelect={onSelect} /> : <Empty title={view === 'back-burner' ? query ? 'No matching ideas' : 'Nothing on the back burner' : query || status !== 'all' ? 'No matching ideas' : 'Room for the next question'} action={view !== 'back-burner' && !query && status === 'all' ? <button onClick={onCreate}>New idea</button> : undefined}>{view === 'back-burner' ? 'Move an idea here from its details when it can wait. Its notes and connections stay available.' : query || status !== 'all' ? 'Try another search or status.' : 'Collect a question here, then connect it to a project or experiment.'}</Empty>}
  </section>;
}

function AllResearchRecords({ state, query, onSelect }: { state: AppState; query: string; onSelect: (id: string) => void }) {
  const [kind, setKind] = useState('Experiment');
  const records = state.entities.filter(entity => entity.projectIds.includes(state.selectedProjectId) && (kind === 'All' || entity.kind === kind) && `${entity.id} ${entity.title} ${entity.body}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="content-list"><div className="list-toolbar"><label>Record type <select value={kind} onChange={event => setKind(event.target.value)}>{['Experiment','Claim','Artifact','Note','Idea','Paper','All'].map(value => <option key={value}>{value}</option>)}</select></label><span>{records.length} records</span></div><p className="collection-note">Complete project history, including records outside the current scientific argument. Availability and Back burner labels remain explicit.</p><RecordCards records={records} projects={state.projects} onSelect={onSelect} /></section>;
}

function BackBurnerExperiments({ state, query, onSelect }: { state: AppState; query: string; onSelect: (id: string) => void }) {
  const records = state.entities.filter(entity => (entity.kind === 'Experiment' || entity.kind === 'Claim') && entity.projectIds.includes(state.selectedProjectId) && isBackBurner(entity) && `${entity.title} ${entity.body} ${entity.metadata.backBurner?.reason || ''}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="content-list"><p className="collection-note">Historical or deferred work. Records stay accessible here and in All records; jobs remain in Runs.</p>{records.length ? <RecordCards records={records} projects={state.projects} onSelect={onSelect} /> : <Empty title={query ? 'No matching experiments or claims' : 'Nothing on the back burner'}>{query ? 'Try a different search.' : 'Move an experiment here from its details when it can wait. You can restore it at any time.'}</Empty>}</section>;
}

function Runs({ runs, entities, onSelect, send, query }: { runs: any[]; entities: Entity[]; onSelect: (id: string) => void; send: Send; query: string }) {
  const [expanded, setExpanded] = useState('');
  const visible = runs.filter(run => `${run.requestId} ${run.state} ${run.name || ''} ${run.jobId || ''}`.toLowerCase().includes(query.toLowerCase()));
  if (!visible.length) return <Empty title={query ? 'No matching runs' : 'No recorded runs yet'}>{query ? 'Try a different job ID or state.' : 'Prepare an experiment through the research CLI or your agent. Review its frozen command and resources here before submission.'}</Empty>;
  return <div className="runs-list">{visible.map((run, index) => {
    const id = run.requestId || run.id || String(index);
    const experiment = entities.find(entity => entity.id === run.experimentId);
    const state = run.state || run.status || 'Unknown';
    const resources = run.spec?.resources;
    const units: any[] = run.units || [];
    return <article className="run-card" key={id}>
      <button className="run-heading" onClick={() => setExpanded(expanded === id ? '' : id)} aria-expanded={expanded === id}>
        <span className={`status-dot ${statusTone(state)}`} /><span><strong>{run.name || experiment?.title || id}</strong><small>{id}{run.readOnly ? ' · Observed job' : ''}{experiment && isBackBurner(experiment) ? ' · Back burner' : ''}</small></span><span className={`badge ${statusTone(state)}`}>{state}</span><span>{expanded === id ? '−' : '+'}</span>
      </button>
      {expanded === id && <div className="run-detail">
        {experiment && isBackBurner(experiment) && <p className="notice subtle">This experiment is on the back burner. Its runs continue normally.</p>}
        <dl>
          <dt>Experiment</dt><dd>{experiment ? <button className="text-button" onClick={() => onSelect(experiment.id)}>{experiment.title}</button> : 'Not linked'}</dd>
          <dt>Job</dt><dd><code>{run.jobId || 'Not submitted'}</code>{run.elapsed ? ` · ${run.elapsed}` : ''}</dd>
          <dt>Source revision</dt><dd><code>{run.snapshot?.git?.commit || 'Unknown'}</code>{run.snapshot?.git?.dirty ? ' + saved changes' : ''}</dd>
          <dt>Snapshot</dt><dd><code>{run.snapshot?.hash?.slice(0, 16) || 'Not recorded'}</code></dd>
          <dt>Run folder</dt><dd><code>{run.root || 'Existing project output'}</code></dd>
          {resources && <><dt>Resources</dt><dd>{resources.partition} · {resources.gpus || 0} GPU · {resources.cpus || '?'} CPU · {resources.memory || 'Memory unknown'} · {resources.time || 'Time unknown'}</dd></>}
          {!run.readOnly && <><dt>Retry limit</dt><dd>{run.spec?.retryLimit || 0}</dd></>}
        </dl>
        {run.lastError && <p className="notice">{run.lastError}</p>}
        {(run.warnings || []).map((warning: string, i: number) => <p className="notice" key={i}>{warning}</p>)}
        {units.map((unit, unitIndex) => {
          const execution = run.execution?.units?.find((item: any) => item.id === unit.id);
          return <div className="unit-row" key={unit.id || unitIndex}><div className="attempt-row"><strong>{unit.id}</strong><span>{unit.condition || unit.stage || ''}{unit.seed !== undefined ? ` · seed ${unit.seed}` : ''}</span><span className={`badge ${statusTone(execution?.state)}`}>{execution?.state || 'Prepared'}</span></div><pre className="run-command">{(unit.resolvedCommand || unit.command || []).join(' ')}</pre>{execution?.attemptId && <p className="quiet">Attempt: {execution.attemptId}{execution.exitCode !== undefined ? ` · exit ${execution.exitCode}` : ''}</p>}{execution?.error && <p className="notice">{execution.error}</p>}</div>;
        })}
        {!units.length && !!run.spec?.command?.length && <pre className="run-command">{run.spec.command.join(' ')}</pre>}
        {run.readOnly ? <p className="quiet">Observed from Slurm. This job continues under its original launcher.</p> : <div className="detail-actions">{state === 'Prepared' && <button className="primary" onClick={() => send('submitRun', { requestId: id })}>Submit run</button>}{['Submitting', 'Unknown'].includes(state) && <button onClick={() => send('reconcileRun', { requestId: id })}>Check submission</button>}{run.root && <button onClick={() => send('openSource', { source: { path: `${run.root}/manifest.json`, label: 'Run manifest' } })}>Open manifest ↗</button>}</div>}
      </div>}
    </article>;
  })}</div>;
}

function Report({ state, send }: { state: AppState; send: Send }) {
  const report = state.report;
  if (!report && state.projects.find(project => project.id === state.selectedProjectId)?.metadata.report?.path) return <Empty title="Loading report status…">Checking the linked report. You can keep switching between pages.</Empty>;
  if (!report || report.state === 'unconfigured') return <Empty title="Connect your report" action={<button className="primary" onClick={() => send('configureProject', { projectId: state.selectedProjectId })}>Set report folder</button>}>Choose the local Git clone of your Overleaf project. The original LaTeX files remain editable in VS Code.</Empty>;
  const names: Record<string, string> = { clean: 'Up to date', dirty: 'Local changes', ahead: 'Ready to publish', behind: 'Updates available', diverged: 'Branches differ', offline: 'Offline', error: 'Sync error' };
  return <section className="document-page"><article className="integration-card"><div className="integration-header"><span className="integration-icon">▤</span><div><h2>Overleaf report</h2><p>{report.repo}</p></div><span className={`badge ${statusTone(report.state === 'clean' ? 'Supported' : report.state === 'error' ? 'Failed' : 'Needs review')}`}>{names[report.state] || report.state}</span></div><dl><dt>Branch</dt><dd>{report.branch || 'Not recorded'}</dd><dt>Remote</dt><dd>{report.remote || 'Not configured'}</dd><dt>Commits</dt><dd>{report.ahead || 0} ahead · {report.behind || 0} behind</dd><dt>Last check</dt><dd>{report.lastSyncedAt ? new Date(report.lastSyncedAt).toLocaleString() : 'Not checked yet'}</dd></dl>{report.message && <p className="notice">{report.message}</p>}<div className="detail-actions"><button className="primary" onClick={() => send('reportOpen', {})}>Open report ↗</button><button onClick={() => send('reportSync')}>Check for updates</button><button disabled={report.state === 'dirty' || report.state === 'diverged' || report.state === 'offline'} onClick={() => send('reportPush')}>Publish to Overleaf</button></div><p className="quiet">Updates are pulled when the clone is clean and can fast-forward. Publish sends your committed changes to Overleaf.</p></article>
    {!!report.changedFiles?.length && <article className="integration-card"><h3>Local changes</h3><div className="changed-files">{report.changedFiles.map((file: string, index: number) => <button className="source-link" key={index} onClick={() => send('reportOpen', { path: file.replace(/^\s*[MADRCU?!]{1,2}\s+/, '') })}><code>{file}</code><span>↗</span></button>)}</div></article>}
  </section>;
}

function Files({ state, send, query }: { state: AppState; send: Send; query: string }) {
  const [type, setType] = useState('all');
  const [selectedFile, setSelectedFile] = useState('');
  const [targetId, setTargetId] = useState('');
  const files = (state.files || []).filter(file => `${file.name} ${file.path || ''}`.toLowerCase().includes(query.toLowerCase()) && (type === 'all' || (type === 'slides' && /presentation/.test(file.mimeType)) || (type === 'documents' && /document|pdf|text/.test(file.mimeType)) || (type === 'folders' && /folder/.test(file.mimeType))));
  if (!state.driveConnected) return <Empty title="Your research files, connected" action={<div className="detail-actions"><button className="primary" onClick={() => send('connectDrive')}>Connect Google Drive</button><button onClick={() => send('configureProject', { projectId: state.selectedProjectId })}>Set Drive folder</button></div>}>Browse the project folder and link slides or documents to a claim or experiment.</Empty>;
  return <section className="content-list"><div className="list-toolbar"><label className="compact-label">Type<select value={type} onChange={event => setType(event.target.value)}><option value="all">All files</option><option value="slides">Slides</option><option value="documents">Documents</option><option value="folders">Folders</option></select></label><span className="quiet">{files.length} files</span><button className="toolbar-end" onClick={() => send('listDrive', {})}>Refresh files</button><button onClick={() => send('configureProject', { projectId: state.selectedProjectId })}>Set folder</button></div>
    {files.length ? <div className="file-list">{files.map(file => <article className="file-row" key={file.id}><span className="file-icon" aria-hidden="true">{/folder/.test(file.mimeType) ? '▱' : /presentation/.test(file.mimeType) ? '▣' : '▤'}</span><button className="file-open" onClick={() => send('openSource', { source: { url: file.webViewLink || `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`, label: file.name } })}><strong>{file.name}</strong><small>{file.path || file.mimeType?.replace('application/vnd.google-apps.', '')}{file.modifiedTime ? ` · ${new Date(file.modifiedTime).toLocaleDateString()}` : ''}</small></button><button onClick={() => { setSelectedFile(selectedFile === file.id ? '' : file.id); setTargetId(''); }}>Link to record</button>{selectedFile === file.id && <form className="file-link-form" onSubmit={event => { event.preventDefault(); send('linkDriveFile', { fileId: file.id, entityId: targetId }); setSelectedFile(''); }}><label>Record<select required value={targetId} onChange={event => setTargetId(event.target.value)}><option value="">Choose a record</option>{state.entities.filter(entity => entity.projectIds.includes(state.selectedProjectId)).map(entity => <option key={entity.id} value={entity.id}>{entity.kind}: {entity.title}</option>)}</select></label><button type="submit" className="primary">Save link</button><button type="button" onClick={() => setSelectedFile('')}>Cancel</button></form>}</article>)}</div> : <Empty title="No matching files">{query || type !== 'all' ? 'Try a different name or file type.' : 'Set the project folder, then refresh to browse its files.'}</Empty>}
  </section>;
}

function App() {
  const { state, send, error, dismissError } = useBridge();
  const [selectedId, setSelectedId] = useState(vscode?.getState()?.selectedId || '');
  const [detailHistory, setDetailHistory] = useState<string[]>([]);
  const detailScroll = useRef(new Map<string, number>());
  const detailOrigin = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState('');
  const [experimentView, setExperimentView] = useState('map');
  const [ideaView, setIdeaView] = useState('current');
  const [ideaScope, setIdeaScope] = useState('project');
  const [editor, setEditor] = useState<{ kind: EntityKind; entity?: Entity } | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addingPaper, setAddingPaper] = useState(false);
  const [sourceRoot, setSourceRoot] = useState('');
  const project = state.projects.find(item => item.id === state.selectedProjectId);
  const repos: { path: string; name?: string }[] = project?.metadata.repos || (project?.metadata.sourceRoot ? [{ path: project.metadata.sourceRoot }] : []);
  const selectedEntity = state.entities.find(entity => entity.id === selectedId) || state.projects.find(entity => entity.id === selectedId);
  const selectedNode = state.section === 'Source Code' ? state.graph?.nodes.find(node => node.id === selectedId) : undefined;
  const data = useMemo(() => state.section === 'Source Code' ? state.graph || { nodes: [], edges: [] } : researchMap(project, state.entities, state.section), [project, state.entities, state.section, state.graph]);
  const flowIds = project?.metadata.researchFlow?.version === 1 && Array.isArray(project.metadata.researchFlow.nodeIds) ? new Set(project.metadata.researchFlow.nodeIds) : undefined;
  const claims = state.entities.filter(entity => entity.kind === 'Claim' && !isBackBurner(entity) && entity.projectIds.includes(state.selectedProjectId) && (!flowIds || flowIds.has(entity.id)));
  const related = state.entities.filter(entity => entity.projectIds.includes(state.selectedProjectId));
  const parkedExperiments = related.filter(entity => (entity.kind === 'Experiment' || entity.kind === 'Claim') && isBackBurner(entity));
  const parkedIdeas = state.entities.filter(entity => entity.kind === 'Idea' && isBackBurner(entity) && (ideaScope === 'all' || entity.projectIds.includes(state.selectedProjectId)));
  const matchingParkedExperiments = parkedExperiments.filter(entity => `${entity.title} ${entity.body} ${entity.metadata.backBurner?.reason || ''}`.toLowerCase().includes(query.toLowerCase()));
  const handoff = primaryHandoff(project, related);
  const proposed = new Set(related.filter(note => note.kind === 'Note' && note.status === 'Proposed').flatMap(note => note.links.filter(link => link.relation === 'proposes').map(link => link.target)));
  const proposal = nextStep(handoff?.body);
  const rememberScroll = () => { if (selectedId) detailScroll.current.set(selectedId, document.querySelector('.details-panel')?.scrollTop || 0); };
  const select = (id: string) => {
    if (id === selectedId) return;
    if (!selectedId && id) detailOrigin.current = document.activeElement as HTMLElement;
    rememberScroll();
    setDetailHistory(previous => !id ? [] : selectedId ? [...previous, selectedId] : previous);
    setSelectedId(id); vscode?.setState({ selectedId: id });
    if (id) requestAnimationFrame(() => document.querySelector<HTMLElement>('.details-panel h2')?.focus({ preventScroll: true }));
    if (!id) requestAnimationFrame(() => {
      const target = detailOrigin.current?.isConnected ? detailOrigin.current :
        document.querySelector<HTMLElement>('.workspace-toolbar .segmented button.active') || document.querySelector<HTMLElement>('.section-nav button[aria-current="page"]');
      target?.focus({ preventScroll: true });
    });
  };
  const back = () => {
    rememberScroll();
    const id = detailHistory.at(-1) || '';
    setDetailHistory(previous => previous.slice(0, -1));
    setSelectedId(id); vscode?.setState({ selectedId: id });
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.details-heading button')?.focus({ preventScroll: true }));
  };
  const showDetails = !!selectedEntity || !!selectedNode;
  useEffect(() => { setQuery(''); setSelectedId(''); setDetailHistory([]); detailScroll.current.clear(); }, [state.selectedProjectId, state.section, state.selectedSourceRoot, state.graph?.mode]);
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !editor) { if (showAdd) setShowAdd(false); else if (selectedId && !document.querySelector('.inline-form')) select(''); }
    };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [selectedId, editor, showAdd]);
  useEffect(() => { setSourceRoot(project?.metadata.sourceRoot || repos[0]?.path || ''); }, [state.selectedProjectId]);
  const descriptions: Record<Section, string> = {
    Overview: projectSummary(project) || 'Follow the claims. See the evidence. Know what needs review.',
    Ideas: ideaScope === 'all' ? 'Questions worth keeping, across all your research.' : 'Questions worth keeping for this project.',
    Experiments: 'Connect each comparison to the question it answers.',
    'Related work': 'Papers and code this project builds on, compares with, or cites.',
    'Source Code': 'Start with the map. Open the code when you need the details.',
    Report: 'Keep your paper close to the work behind it.',
    Files: 'Find the slides and documents behind your progress.',
  };
  const authoredFlow = project?.metadata.researchFlow?.version === 1;
  const argument = state.section === 'Overview' ? argumentOf(project) : undefined;
  const reportedAny = claims.some(claim => claim.metadata.reportedVerdict);
  const graphSection = (state.section === 'Overview' && !argument) || state.section === 'Source Code' || (state.section === 'Experiments' && experimentView === 'map');
  return <div className="app-shell">
    <header className="app-header"><div className="brand"><span className="brand-mark">◈</span><span>Research</span></div><span className="header-divider" /><label className="project-picker"><span className="sr-only">Current project</span><select aria-label="Current project" value={state.selectedProjectId} onChange={event => send('selectProject', { projectId: event.target.value })}>{!state.projects.length && <option value="">Choose a project</option>}{state.projects.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><div className="header-actions"><button className="new-project-button" onClick={() => send('configureProject', { create: true })}>+ New project</button><span className="sync-note"><span className={`status-dot ${state.loading ? 'amber' : 'green'}`} />{state.loading ? 'Updating' : 'Shared memory'}</span><button className="icon-button" title="Refresh records" aria-label="Refresh records" onClick={() => send('refresh')}>↻</button><button className="icon-button" title="Project settings" aria-label="Project settings" onClick={() => send('configureProject', { projectId: state.selectedProjectId })}>⚙</button></div></header>
    <nav className="section-nav" aria-label="Research sections">{sections.map(section => <button key={section} className={state.section === section ? 'active' : ''} onClick={() => send('selectSection', { section })} aria-current={state.section === section ? 'page' : undefined}><span aria-hidden="true">{sectionIcons[section]}</span>{section}{section === 'Related work' && <small>{state.entities.filter(entity => entity.kind === 'Paper' && entity.projectIds.includes(state.selectedProjectId)).length}</small>}{section === 'Ideas' && <small>{state.entities.filter(entity => entity.kind === 'Idea' && entity.status !== 'Merged' && !isBackBurner(entity) && (ideaScope === 'all' || entity.projectIds.includes(state.selectedProjectId))).length}</small>}</button>)}</nav>
    <div className="page-heading"><div><div className="eyebrow">{state.section === 'Overview' ? 'PROJECT OVERVIEW' : project?.title || 'RESEARCH MANAGER'}</div><h1>{state.section === 'Overview' ? project?.title || 'Your research, in view' : state.section}</h1><p><InlineMath text={descriptions[state.section]} /></p>{state.section === 'Overview' && proposal && <p className="next-step"><span>Next proposal</span><button className="text-button" title={proposal} onClick={() => select(handoff.id)}><InlineMath text={proposal} /></button></p>}</div><div className="page-actions">{state.section === 'Overview' && handoff && <button onClick={() => select(handoff.id)}>Handoff ↗</button>}{['Overview', 'Ideas', 'Experiments'].includes(state.section) && <div className="add-control"><button className="primary" aria-expanded={showAdd} onClick={() => setShowAdd(!showAdd)}>+ New record</button>{showAdd && <div className="add-menu" role="menu">{(['Idea', 'Claim', 'Experiment', 'Note'] as EntityKind[]).map(kind => <button role="menuitem" key={kind} onClick={() => { setEditor({ kind }); setShowAdd(false); }}>{kind === 'Note' ? 'Observation / note' : kind}</button>)}<button role="menuitem" onClick={() => { setAddingPaper(true); setShowAdd(false); }}>Paper</button></div>}</div>}</div></div>
    {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" onClick={dismissError} aria-label="Dismiss error">×</button></div>}
    {!!state.errors.length && <details className="state-errors"><summary>{state.errors.length} record or connection issue{state.errors.length === 1 ? '' : 's'}</summary>{state.errors.map((message, index) => <p key={index}>{message}</p>)}</details>}
    {!project && !state.loading ? <Empty title="Start with a research project" action={<button className="primary" onClick={() => send('configureProject', {})}>Set up project</button>}>Connect a shared memory folder to bring projects, claims, and experiments into view.</Empty> : <>
      {state.section === 'Overview' && <div className="overview-stats"><button onClick={() => setQuery('')}><span>{claims.length}</span><small>Claims</small></button><button onClick={() => setQuery('Supported')}><span className="stat-green">{claims.filter(claim => claim.status === 'Supported' && !claim.metadata.needsReview).length}</span><small>{reportedAny ? 'You confirmed' : 'Supported'}</small></button>{reportedAny && <button onClick={() => setQuery('')} title="Verdicts read from the source, not your judgments"><span className="stat-green">{claims.filter(claim => claim.metadata.reportedVerdict === 'Supported').length}<small className="stat-of">/{claims.length}</small></span><small>Reported supported</small></button>}<button onClick={() => setQuery('Needs review')}><span className="stat-amber">{related.filter(claim => claim.kind === 'Claim' && !isBackBurner(claim) && (claim.metadata.needsReview || (claim.status === 'Open' && proposed.has(claim.id)))).length}</span><small>Need review</small></button><button onClick={() => setQuery('Experiment')}><span>{related.filter(entity => entity.kind === 'Experiment' && (!flowIds || flowIds.has(entity.id))).length}</span><small>Experiments</small></button><p>Judgments are yours.<br /><span>Evidence stays connected.</span></p></div>}
      <div className="workspace-toolbar"><div className="toolbar-context">{state.section === 'Source Code' ? <div className="segmented" aria-label="Code view"><button className={state.graph?.mode !== 'modules' ? 'active' : ''} onClick={() => send('codeMode', { mode: 'data' })}>Data flow</button><button className={state.graph?.mode === 'modules' ? 'active' : ''} onClick={() => send('codeMode', { mode: 'modules' })}>Modules</button></div> : state.section === 'Experiments' ? <div className="segmented" aria-label="Experiment view"><button className={experimentView === 'map' ? 'active' : ''} onClick={() => setExperimentView('map')}>Research map</button><button className={experimentView === 'all' ? 'active' : ''} onClick={() => setExperimentView('all')}>All records</button><button className={experimentView === 'back-burner' ? 'active' : ''} aria-pressed={experimentView === 'back-burner'} onClick={() => setExperimentView('back-burner')}>Back burner <small>{parkedExperiments.length}</small></button><button className={experimentView === 'runs' ? 'active' : ''} onClick={() => setExperimentView('runs')}>Runs <small>{state.runs?.length || 0}</small></button></div> : state.section === 'Ideas' ? <div className="segmented" aria-label="Idea view"><button className={ideaView === 'current' ? 'active' : ''} aria-pressed={ideaView === 'current'} onClick={() => setIdeaView('current')}>Current</button><button className={ideaView === 'back-burner' ? 'active' : ''} aria-pressed={ideaView === 'back-burner'} onClick={() => setIdeaView('back-burner')}>Back burner <small>{parkedIdeas.length}</small></button></div> : <span className="toolbar-title">{state.section === 'Overview' ? (argument ? 'Argument' : authoredFlow ? 'Scientific argument · history remains in linked records' : 'Research map') : state.section === 'Report' ? 'Local report' : state.section === 'Related work' ? 'Papers in this project' : 'Project files'}</span>}{state.section === 'Source Code' && repos.length > 0 && <label className="source-picker"><span className="sr-only">Source repository</span><select aria-label="Source repository" value={sourceRoot || repos[0]?.path} onChange={event => { setSourceRoot(event.target.value); send('selectSource', { sourceRoot: event.target.value }); }}>{repos.map(repo => <option key={repo.path} value={repo.path}>{repo.name || repo.path.split('/').filter(Boolean).pop()}</option>)}</select></label>}{graphSection && <span className="toolbar-description">Select a node for details</span>}</div>{state.section !== 'Report' && <label className="search-field"><span aria-hidden="true">⌕</span><input aria-label="Search current view" value={query} onChange={event => setQuery(event.target.value)} placeholder={state.section === 'Files' ? 'Find a file…' : 'Find in this view…'} />{query && <button aria-label="Clear search" onClick={() => setQuery('')}>×</button>}</label>}</div>
      {state.section === 'Source Code' && state.graph?.stale && <div className="notice code-notice">{state.graph.nodes.some(node => node.status === 'Needs review') ? 'Some descriptions refer to a different source snapshot. Review the marked nodes before relying on them.' : 'Source files changed. The map now reflects the current source.'} <button className="text-button" onClick={() => send('codeMode', { mode: state.graph?.mode || 'data' })}>Refresh map</button></div>}
      {state.section === 'Experiments' && experimentView === 'map' && query && matchingParkedExperiments.length > 0 && <div className="collection-discovery"><button className="text-button" onClick={() => setExperimentView('back-burner')}>{matchingParkedExperiments.length} matching {matchingParkedExperiments.length === 1 ? 'experiment' : 'experiments'} in Back burner →</button></div>}
      <div className={`workspace-body ${showDetails ? 'with-details' : ''}`}><main className={`main-content ${graphSection ? 'graph-content' : ''}`}>
        {graphSection && state.section === 'Source Code' && !state.graph ? <Empty title={state.loading ? 'Loading code map…' : 'No code map yet'}>{state.loading ? 'Reading the selected source repository.' : 'Choose a source folder in Project settings, or refresh to try again.'}</Empty> : graphSection && <ResearchMap data={data} selectedId={selectedId} onSelect={select} identity={`${state.selectedProjectId}:${state.section}:${state.graph?.mode || ''}:${sourceRoot}`} query={query} />}
        {argument && project && <ResearchHealth projectId={project.id} entities={[project, ...state.entities.filter(entity => entity.id !== project.id)]} onSelect={select} />}
        {argument && project && <OverviewArgument project={project} argument={argument} entities={state.entities} send={send} onSelect={select} onOpenMap={() => { setExperimentView('map'); send('selectSection', { section: 'Experiments' }); }} />}
        {state.section === 'Ideas' && <Ideas state={state} query={query} view={ideaView} setView={setIdeaView} scope={ideaScope} setScope={setIdeaScope} onSelect={select} onCreate={() => setEditor({ kind: 'Idea' })} />}
        {state.section === 'Experiments' && experimentView === 'all' && <AllResearchRecords state={state} query={query} onSelect={select} />}
        {state.section === 'Experiments' && experimentView === 'back-burner' && <BackBurnerExperiments state={state} query={query} onSelect={select} />}
        {state.section === 'Experiments' && experimentView === 'runs' && <Runs runs={state.runs || []} entities={state.entities} onSelect={select} send={send} query={query} />}
        {state.section === 'Related work' && <RelatedWork state={state} query={query} send={send} onSelect={select} onAdd={() => setAddingPaper(true)} />}
        {state.section === 'Report' && <Report state={state} send={send} />}
        {state.section === 'Files' && <Files state={state} send={send} query={query} />}
      </main>{showDetails && <Details key={selectedId} entity={selectedEntity} node={selectedNode} entities={[...state.projects, ...state.entities.filter(entity => entity.kind !== 'Project')]} send={send} onClose={() => select('')} onEdit={entity => setEditor({ kind: entity.kind, entity })} onSelect={select} onBack={detailHistory.length ? back : undefined} backTitle={state.entities.find(entity => entity.id === detailHistory.at(-1))?.title} initialScroll={detailScroll.current.get(selectedId) || 0} />}</div>
      <footer className="app-footer"><span>{project?.title || 'Research Manager'}</span><span>{state.section === 'Source Code' ? `Source: ${state.graph?.revision?.slice(0, 12) || 'Not indexed'}` : `${related.length} shared records`}</span><span>Markdown backed · Local index</span></footer>
    </>}
    {state.loading && !state.projects.length && <div className="initial-loading" role="status"><span className="loading-ring" />Loading research memory…</div>}
    {addingPaper && project && <AddPaperDialog projectId={project.id} projectTitle={project.title} send={send} onClose={() => setAddingPaper(false)} onAdded={id => select(id)} />}
    {editor && <EntityEditor key={editor.entity?.id || editor.kind} entity={editor.entity} kind={editor.kind} projects={state.projects} projectId={state.selectedProjectId} entities={state.entities} send={send} onClose={() => setEditor(null)} />}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
