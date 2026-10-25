import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ResearchStore } from './store.js';
import { buildCodeGraph } from './integrations/code-map.js';
import { readReportStatus, syncReport, pushReport, reportOutline, readReport } from './integrations/report.js';
import { DriveError, GoogleDrive } from './integrations/drive.js';
import { listRuns, prepareRun, submitRun, refreshRuns, reconcileSubmission, type RunSpec } from './runs.js';
import { downloadPdf, fetchArxiv, fetchGithub, fetchHfPaper, githubRepos, pageLinks, pageRepos, parsePaperLink, paperKey, parseBibtex, paperFromBib, pdfLinkText, searchArxiv, titleKey, arxivIdFrom, type CodeLink, type Fetcher } from './integrations/papers.js';
import type { AppState, BridgeMessage, CodeGraph, Entity, Section, SourceRef } from './types.js';

const execute = promisify(execFile);
export interface Host {
  openSource(source: SourceRef): Promise<void>;
  connectDrive?(): Promise<GoogleDrive>;
  configureProject?(project?: Entity): Promise<void>;
}

export class ResearchService {
  projectId = '';
  section: Section = 'Overview';
  codeMode: 'data' | 'modules' = 'data';
  selectedSourceRoot = '';
  private graphRevisions = new Map<string, string>();
  private graphs = new Map<string, CodeGraph>();
  private graphErrors = new Map<string, string>();
  private pendingSections = new Map<string, Promise<void>>();
  private managedRuns: Awaited<ReturnType<typeof listRuns>> = [];
  private connectedDrive?: GoogleDrive;
  private driveConnected = false;
  drive?: GoogleDrive;
  files: any[] = [];
  state?: AppState;
  observedJobs: any[] = [];
  operationalErrors: string[] = [];
  private reportChecks = new Map<string, Awaited<ReturnType<typeof readReportStatus>>>();
  private reportStatuses = new Map<string, Awaited<ReturnType<typeof readReportStatus>>>();
  private driveErrors = new Map<string, string>();
  constructor(readonly store: ResearchStore, readonly host?: Host, readonly fetcher: Fetcher = globalThis.fetch as unknown as Fetcher) {}

  project() {
    const projects = this.store.list(undefined, 'Project');
    return projects.find(p => p.id === this.projectId) || projects[0];
  }

  private currentProject(projects = this.store.list(undefined, 'Project')) {
    const project = projects.find(p => p.id === this.projectId) || projects[0];
    this.projectId = project?.id || '';
    if (this.state && this.state.selectedProjectId !== this.projectId) { this.selectedSourceRoot = ''; this.files = []; }
    return project;
  }

  private sourceRoot(project?: Entity) {
    const source = this.selectedSourceRoot || project?.metadata.sourceRoot || project?.metadata.repos?.[0]?.path;
    return source ? path.resolve(source) : undefined;
  }

  private graphKey(root: string, mode = this.codeMode) { return JSON.stringify([root, mode]); }

  async snapshot(options: {cached?: boolean} = {}): Promise<AppState> {
    if (!options.cached) {
      await this.store.reindex();
      this.managedRuns = await listRuns(this.store.root);
      await this.checkDriveConnection();
      await this.loadSection({force:true});
      const report = this.currentProject()?.metadata.report;
      if (report?.path && this.section !== 'Report') await this.loadReport(report, true);
    }
    const entities = this.store.list(), projects = entities.filter(e => e.kind === 'Project');
    const project = this.currentProject(projects), sourceRoot = this.sourceRoot(project);
    const state: AppState = { projects, entities, selectedProjectId:this.projectId, selectedSourceRoot:sourceRoot, section:this.section, runs:this.managedRuns.filter(r => r.projectId === this.projectId), errors:[...this.store.errors,...this.operationalErrors], memoryRoot:this.store.root,files:this.files,driveConnected:!!this.drive && (this.drive !== this.connectedDrive || this.driveConnected) };
    if (!state.driveConnected) { this.files = []; state.files = []; }
    const driveError = this.driveErrors.get(this.projectId);
    if (driveError) state.errors.push(driveError);
    state.runs!.push(...this.observedJobs.filter(j => j.projectId === this.projectId));
    if (this.section === 'Source Code' && sourceRoot) {
      const key = this.graphKey(sourceRoot);
      state.graph = this.graphs.get(key);
      state.loading = this.pendingSections.has(`source:${key}`);
      const error = this.graphErrors.get(key);
      if (error) state.errors.push(error);
    }
    if (project?.metadata.report?.path) {
      const key = this.reportKey(project.metadata.report);
      state.report = this.reportStatuses.get(key);
      if (this.section === 'Report') state.loading = this.pendingSections.has(`report:${key}`);
      if (state.report && ['error', 'offline', 'diverged'].includes(state.report.state) && state.report.message) state.errors.push(state.report.message);
    }
    else state.report = { state:'unconfigured',message:'Link an Overleaf clone in project settings.' };
    this.state = state;
    return state;
  }

  private async checkDriveConnection() {
    const drive = this.drive;
    const connected = drive ? await drive.getConnectionState() : false;
    if (this.drive === drive) { this.connectedDrive = drive; this.driveConnected = connected; }
  }

  private sectionTask(key: string, operation: () => Promise<void>) {
    const pending = this.pendingSections.get(key);
    if (pending) return pending;
    const task = operation().finally(() => { if (this.pendingSections.get(key) === task) this.pendingSections.delete(key); });
    this.pendingSections.set(key, task);
    return task;
  }

  private loadReport(report: {path:string;remote?:string}, force: boolean) {
    const key = this.reportKey(report);
    if (!force && this.reportStatuses.has(key)) return Promise.resolve();
    return this.sectionTask(`report:${key}`, async () => {
      let status = await readReportStatus(report.path, report.remote || 'origin');
      const previous = this.reportChecks.get(key);
      if (previous?.lastSyncedAt) status.lastSyncedAt = previous.lastSyncedAt;
      if (previous && ['offline','error'].includes(previous.state) && status.state !== 'dirty') status = {...status,state:previous.state,message:previous.message};
      this.reportStatuses.set(key, status);
    });
  }

  async loadSection(options: {force?: boolean} = {}) {
    const project = this.currentProject();
    if (this.section === 'Source Code') {
      const root = this.sourceRoot(project), mode = this.codeMode;
      if (!root) return;
      const key = this.graphKey(root, mode);
      if (!options.force && this.graphs.has(key)) return;
      await this.sectionTask(`source:${key}`, async () => {
        try {
          const graph = await buildCodeGraph(root, mode, {previousRevision:this.graphRevisions.get(root)});
          this.graphs.set(key, graph);
          this.graphRevisions.set(root, graph.revision);
          this.graphErrors.delete(key);
        } catch (error) { this.graphErrors.set(key, (error as Error).message); }
      });
    } else if (this.section === 'Report' && project?.metadata.report?.path) {
      await this.loadReport(project.metadata.report, !!options.force);
    } else if (this.section === 'Files') await this.checkDriveConnection();
  }

  edit(id: string, expectedRevision?: number, expectedHash?: string) {
    const e = this.state?.entities.find(e => e.id === id) || this.store.get(id);
    return { expectedRevision:expectedRevision ?? e.revision,expectedHash:expectedHash ?? e.contentHash!,actor:'human' as const };
  }

  private displayedEdit(payload: any) {
    if (!Number.isInteger(payload.expectedRevision) || typeof payload.expectedHash !== 'string' || !payload.expectedHash) {
      throw new Error('The displayed record version is missing. Refresh and review the record again.');
    }
    return this.edit(payload.id, payload.expectedRevision, payload.expectedHash);
  }

  async command(message: BridgeMessage) {
    const p = message.payload || {};
    const projectAction = ['reportSync','reportPush','reportOpen','listDrive','linkDriveFile','connectDrive'].includes(message.command)
      || (message.command === 'configureProject' && p.create !== true && !p.projectId);
    if (projectAction && p.contextProjectId !== undefined && p.contextProjectId !== (this.project()?.id || '')) {
      throw new Error('The selected project changed. Return to the original project and try this action again.');
    }
    switch (message.command) {
      case 'ready': break;
      case 'refresh': await this.refresh(); break;
      case 'selectProject': this.projectId = p.projectId; this.selectedSourceRoot = ''; this.files = []; break;
      case 'selectSource': {
        const project = this.project();
        const allowed = [project?.metadata.sourceRoot, ...(project?.metadata.repos || []).map((repo: any) => repo.path)].filter((source): source is string => typeof source === 'string');
        if (typeof p.sourceRoot !== 'string' || !allowed.some(source => path.resolve(source) === path.resolve(p.sourceRoot))) throw new Error('Choose a source repository linked to this project.');
        this.selectedSourceRoot = path.resolve(p.sourceRoot);
        break;
      }
      case 'selectSection': this.section = p.section; break;
      case 'codeMode': this.codeMode = p.mode === 'modules' ? 'modules' : 'data'; break;
      case 'openSource': await this.host?.openSource(p.source); break;
      case 'openEntity': await this.host?.openSource({path:this.store.get(p.id).filePath}); break;
      case 'saveEntity': {
        const e = p.entity as Partial<Entity>;
        if (e.id && this.store.list().some(old => old.id === e.id)) {
          const current = this.store.get(e.id);
          if (current.kind === 'Claim' && e.status && e.status !== current.status) throw new Error('Use Review claim to change its verdict.');
          await this.store.update(e.id,e,this.displayedEdit({id:e.id,expectedRevision:p.expectedRevision,expectedHash:p.expectedHash ?? e.contentHash}));
        } else await this.store.create(e,'human');
        break;
      }
      case 'reviewClaim': await this.store.reviewClaim(p.id,p.status,p.reason,this.displayedEdit(p)); break;
      case 'invalidateArtifact': await this.store.invalidateArtifact(p.id,p.reason,this.displayedEdit(p)); break;
      case 'setBackBurner': await this.store.setBackBurner(p.id,p.active,p.reason ?? '',this.displayedEdit(p),{category:p.category,supersededBy:p.supersededBy}); break;
      case 'mergeIdeas': await this.mergeIdeas(p.sourceId,p.targetId,p.expectedRevision,p.expectedHash); break;
      case 'prepareRun': this.rememberRun(await this.prepare(p.spec)); break;
      case 'submitRun': this.rememberRun(await submitRun(this.store.root,p.requestId)); break;
      case 'reconcileRun': this.rememberRun(await reconcileSubmission(this.store.root,p.requestId)); break;
      case 'reportOpen': {
        const report = this.project()?.metadata.report;
        if (!report?.path) throw new Error('Link an Overleaf clone in project settings.');
        await this.host?.openSource({path:path.join(report.path,p.path || report.mainFile || 'main.tex')}); break;
      }
      case 'reportSync': await this.report(false); break;
      case 'reportPush': await this.report(true); break;
      case 'connectDrive': {
        const projectId = this.project()?.id || '';
        this.drive = await this.host?.connectDrive?.();
        if (this.drive) await this.loadDrive({projectId});
        break;
      }
      case 'listDrive': await this.loadDrive(p); break;
      case 'linkDriveFile': await this.linkDrive(p.fileId,p.entityId); break;
      case 'addPaper': await this.addPaper(p, 'human'); break;
      case 'refreshPaper': await this.refreshPaper(p.id, this.displayedEdit(p)); break;
      case 'uploadPaperPdf': {
        if (typeof p.dataBase64 !== 'string') throw new Error('Choose a PDF file to upload.');
        await this.store.attachPaperPdf(p.id, Buffer.from(p.dataBase64, 'base64'), String(p.name || 'paper.pdf'), this.displayedEdit(p)); break;
      }
      case 'fetchPaperPdf': await this.fetchPaperPdf(p.id, this.displayedEdit(p)); break;
      case 'openPaperPdf': {
        const file = this.store.paperPdfPath(this.store.get(p.id));
        if (!file) throw new Error('No PDF is stored for this paper yet.');
        await this.host?.openSource({ path: file }); break;
      }
      case 'configureProject': await this.host?.configureProject?.(p.create === true ? undefined : p.projectId ? this.store.get(p.projectId) : this.project()); break;
      default: throw new Error(`Unknown command: ${message.command}`);
    }
    if (['ready','selectProject','selectSection','selectSource','codeMode','configureProject'].includes(message.command)) {
      await this.loadSection({force:['selectSource','codeMode','configureProject'].includes(message.command)});
    }
    if (['connectDrive','listDrive'].includes(message.command)) await this.checkDriveConnection();
    return this.snapshot({cached:true});
  }

  /** Adds a Paper to one project. arXiv links and GitHub links are looked up; other links need a title. */
  /**
   * One paper from its name or link: find it on arXiv, store its PDF, and look for its code in the abstract/comments,
   * the PDF's links, and Hugging Face Papers. A repo is attached when the authors name it in the abstract or comments,
   * register it on Hugging Face, or two sources agree; PDF-only repos (often baselines) come back unconfirmed to check in the PDF.
   */
  async collectPaper(input: { projectId: string; paper: string; title?: string; codeUrls?: string[]; tags?: string[]; notes?: string; pdf?: boolean; recheck?: boolean }, actor: 'agent' | 'human' = 'agent') {
    let url = input.paper.trim(), existing: Entity | undefined;
    if (!arxivIdFrom(url) && !/^https?:\/\//i.test(url)) {
      const local = this.store.list(input.projectId, 'Paper').filter(p => titleKey(p.title) === titleKey(url) || titleKey(p.title).startsWith(`${titleKey(url)} `));
      if (local.length === 1) existing = local[0];
    }
    if (!existing && !arxivIdFrom(url) && !/^https?:\/\//i.test(url)) {
      const hits = await searchArxiv(url, this.fetcher);
      const exact = hits.filter(hit => titleKey(hit.title) === titleKey(url));
      const close = hits.filter(hit => titleKey(hit.title).includes(titleKey(url)) || titleKey(url).includes(titleKey(hit.title)));
      const pick = exact.length === 1 ? exact[0] : !exact.length && close.length === 1 ? close[0] : undefined;
      const candidates = hits.length ? hits : await searchArxiv(url, this.fetcher, 15000, 'words');
      if (!pick) throw new Error(candidates.length ? `No exact arXiv title match for "${url}". Candidates: ${candidates.map(hit => `${hit.title} (${hit.arxivId})`).join('; ')}. Call again with the right arXiv id.` : `No arXiv paper is titled "${url}". Give its arXiv or web link (with title for a web link).`);
      url = `https://arxiv.org/abs/${pick.arxivId}`;
    }
    // An existing paper is completed rather than refused: missing PDF stored, code searched if never checked (or recheck).
    let paper: Entity;
    if (existing) paper = existing;
    else try { paper = await this.addPaper({ projectId: input.projectId, url, title: input.title, codeUrls: input.codeUrls, tags: input.tags, notes: input.notes }, actor); }
    catch (error) { if (!(error as { existing?: Entity }).existing) throw error; paper = existing = (error as { existing: Entity }).existing; }
    const pdfPresent = () => { const file = this.store.paperPdfPath(paper); return !!file && fsSync.existsSync(file); };
    const edit = () => ({ expectedRevision: paper.revision, expectedHash: paper.contentHash!, actor });
    let pdfError: string | undefined;
    if (input.pdf !== false && paper.metadata.pdfUrl && !pdfPresent()) {
      try { paper = await this.fetchPaperPdf(paper.id, edit()); } catch (error) { pdfError = (error as Error).message; }
    }
    const settled = existing && !input.recheck && ['found', 'confirmed', 'none'].includes(paper.metadata.codeSearch?.result);
    if (settled) return { paper, existing: true, pdf: { stored: pdfPresent(), path: this.store.paperPdfPath(paper), error: pdfError },
      code: { result: paper.metadata.codeSearch.result, attached: (paper.metadata.code ?? []).map((c: CodeLink & { foundIn?: string[] }) => ({ url: c.url, foundIn: c.foundIn ?? ['recorded'] })), unconfirmed: [] } };
    const foundIn = new Map<string, Set<string>>(), checked: string[] = [];
    const note = (repos: string[], source: string) => { checked.push(source); for (const repo of repos) { const key = repo.toLowerCase(); foundIn.set(key, (foundIn.get(key) ?? new Set()).add(source)); } };
    note((input.codeUrls ?? []).map(u => u.trim()).filter(Boolean), 'given');
    note(githubRepos(`${paper.metadata.abstract ?? ''}\n${paper.metadata.comment ?? ''}`), 'abstract');
    const pdfPath = this.store.paperPdfPath(paper);
    if (pdfPath) note(githubRepos(pdfLinkText(await fs.readFile(pdfPath))), 'pdf');
    if (paper.metadata.arxivId) {
      try { const hf = await fetchHfPaper(paper.metadata.arxivId, this.fetcher); note(hf.githubRepo ? githubRepos(hf.githubRepo) : [], 'huggingface'); if (hf.projectPage) paper.metadata.projectPage = hf.projectPage; }
      catch { /* not listed on Hugging Face */ }
    }
    // Project pages named by the authors (abstract/comments, Hugging Face) usually carry the code link: follow them one step.
    const pages = [...new Set([...pageLinks(`${paper.metadata.abstract ?? ''}\n${paper.metadata.comment ?? ''}`), ...(paper.metadata.projectPage ? [paper.metadata.projectPage] : [])])].slice(0, 3);
    for (const page of pages) {
      try { const repos = await pageRepos(page, this.fetcher); note(repos.length <= 3 ? repos : [], 'project-page'); paper.metadata.projectPage ??= page; }
      catch { /* page unavailable */ }
    }
    const candidates = [...foundIn].map(([repo, sources]) => ({ url: repo, foundIn: [...sources] }));
    const attach = candidates.filter(c => c.foundIn.some(s => s === 'given' || s === 'abstract' || s === 'huggingface' || s === 'project-page') || c.foundIn.length >= 2);
    const already = new Set((paper.metadata.code ?? []).map((c: CodeLink) => c.url.toLowerCase().replace(/\/$/, '')));
    const fresh = attach.filter(c => !already.has(c.url));
    // Dedupe after GitHub resolves renames/redirects (old-owner/repo → new-owner/repo); merge where each was found.
    const code: (CodeLink & { foundIn?: string[] })[] = [...(paper.metadata.code ?? [])];
    for (const [i, link] of (await this.codeLinks(fresh.map(c => c.url))).entries()) {
      const same = code.find(c => c.url.toLowerCase() === link.url.toLowerCase());
      if (same) same.foundIn = [...new Set([...(same.foundIn ?? []), ...fresh[i].foundIn])];
      else code.push({ ...link, foundIn: fresh[i].foundIn });
    }
    const result = attach.length ? 'found' : candidates.length ? 'unconfirmed' : 'none';
    const codeSearch = { at: new Date().toISOString(), checked, candidates, result };
    paper = await this.store.update(paper.id, { metadata: { ...paper.metadata, code, codeSearch } }, edit());
    return { paper, existing: !!existing, pdf: { stored: pdfPresent(), path: this.store.paperPdfPath(paper), error: pdfError },
      code: { result, attached: code.map((c: CodeLink & { foundIn?: string[] }) => ({ url: c.url, foundIn: c.foundIn ?? ['recorded'] })), unconfirmed: candidates.filter(c => !attach.includes(c)) } };
  }

  /** The researcher's or agent's verdict on a paper's code after reading it: the authors' repositories, or none. */
  async setPaperCode(id: string, codeUrls: string[], reason: string, edit: { expectedRevision: number; expectedHash: string; actor?: 'agent' | 'human' }) {
    const paper = this.store.get(id);
    if (paper.kind !== 'Paper') throw new Error(`Not a paper: ${id}`);
    const code = await this.codeLinks(codeUrls);
    return this.store.update(id, { metadata: { ...paper.metadata, code, codeSearch: { ...(paper.metadata.codeSearch ?? {}), at: new Date().toISOString(), result: code.length ? 'confirmed' : 'none', reason, by: edit.actor ?? 'agent' } } }, edit);
  }

  /** Batch import from BibTeX (pasted, or the report's .bib files) and/or links. Never stops on one bad entry. */
  async importPapers(input: { projectId: string; bibtex?: string; fromReport?: boolean; urls?: string[]; tags?: string[] }, actor: 'agent' | 'human' = 'agent') {
    const project = this.store.get(input.projectId);
    let bib = input.bibtex ?? '';
    if (input.fromReport) {
      const repo = project.metadata.report?.path;
      if (!repo) throw new Error('This project has no linked Overleaf clone. Set it in Project settings, or pass bibtex.');
      const { files } = await reportOutline(repo);
      for (const file of files.filter(name => name.endsWith('.bib'))) bib += '\n' + (await readReport(repo, file, { limit: Infinity })).text;
    }
    const items = [...parseBibtex(bib).map(paperFromBib), ...(input.urls ?? []).map(url => ({ url } as Partial<ReturnType<typeof paperFromBib>>))];
    const created: Entity[] = [], skipped: { id: string; title: string; reason: string }[] = [], failed: { title: string; reason: string }[] = [];
    for (const item of items) {
      const label = item.bibtexKey ? `${item.bibtexKey}: ${item.title || '(no title)'}` : item.title || item.url || '(untitled entry)';
      if (item.unbalanced) { failed.push({ title: item.bibtexKey ?? label, reason: 'Unbalanced braces in this BibTeX entry; fix the .bib and import again.' }); continue; }
      try { created.push(await this.addPaper({ ...item, projectId: project.id, tags: input.tags }, actor)); }
      catch (error) {
        const existing = (error as { existing?: Entity }).existing;
        if (!existing) { failed.push({ title: label, reason: (error as Error).message }); continue; }
        if (item.bibtexKey && !existing.metadata.bibtexKey) await this.store.update(existing.id, { metadata: { ...existing.metadata, bibtexKey: item.bibtexKey } }, { expectedRevision: existing.revision, expectedHash: existing.contentHash!, actor });
        skipped.push({ id: existing.id, title: existing.title, reason: (error as Error).message });
      }
    }
    const warnings = created.filter(p => p.metadata.titleMismatch).map(p => ({ id: p.id, givenTitle: p.metadata.titleMismatch, arxivTitle: p.title, message: 'The BibTeX title differs from arXiv; check that the arXiv id belongs to this entry.' }));
    return { created, skipped, failed, warnings };
  }

  async addPaper(input: { id?: string; projectId?: string; url?: string; codeUrls?: string[]; title?: string; tags?: string[]; notes?: string; authors?: string[]; year?: number; venue?: string; bibtexKey?: string; bibtex?: string }, actor: 'agent' | 'human' = 'agent') {
    const project = this.store.get(String(input.projectId || ''));
    if (project.kind !== 'Project') throw new Error('Choose a research project for this paper.');
    const metadata: Record<string, any> = {};
    let title = input.title?.trim() || '';
    if (input.url?.trim()) {
      const link = parsePaperLink(input.url);
      metadata.paperUrl = link.url;
      if (link.arxivId) {
        metadata.arxivId = link.arxivId;
        try {
          Object.assign(metadata, await fetchArxiv(link.arxivId, this.fetcher));
          // arXiv is the authority for title and authors; a different given title is kept as a warning, not silently used.
          if (title && metadata.title && titleKey(title) !== titleKey(metadata.title)) metadata.titleMismatch = title;
          title = metadata.title || title;
          delete input.authors;
        }
        catch (error) {
          if (!title) throw new Error(`Could not read arXiv metadata: ${(error as Error).message} Enter the title to add the paper without it.`);
          metadata.fetchError = (error as Error).message;
        }
      }
    }
    delete metadata.title;
    if (!title) throw new Error(/doi\.org\//i.test(input.url ?? '') ? 'DOI links are not looked up. Import the BibTeX entry instead, or use research_add_paper with a title.' : 'Enter a title, or paste an arXiv link to fill it in.');
    for (const [key, value] of Object.entries({ authors: input.authors, year: input.year, venue: input.venue })) if (value !== undefined && value !== '' && !(Array.isArray(value) && !value.length)) metadata[key] = value;
    metadata.authors ??= [];
    if (input.bibtexKey) metadata.bibtexKey = input.bibtexKey;
    if (input.bibtex && !metadata.bibtex) metadata.bibtex = input.bibtex;
    if (input.bibtexKey && typeof metadata.bibtex === 'string') metadata.bibtex = metadata.bibtex.replace(/^(\s*@\w+\s*\{)[^,]+,/, `$1${input.bibtexKey},`);
    metadata.tags = (input.tags || []).map(t => t.trim()).filter(Boolean);
    metadata.code = await this.codeLinks(input.codeUrls || []);
    const key = paperKey(metadata);
    const duplicate = this.store.list(project.id, 'Paper').find(paper => (key && paperKey(paper.metadata) === key) || (metadata.bibtexKey && paper.metadata.bibtexKey === metadata.bibtexKey) || titleKey(paper.title) === titleKey(title));
    if (duplicate) throw Object.assign(new Error(`This paper is already in ${project.title}: ${duplicate.title}`), { existing: duplicate });
    return this.store.create({ id: input.id, kind: 'Paper', title, projectIds: [project.id], status: 'To read', body: input.notes?.trim() || '', metadata }, actor);
  }

  private async codeLinks(urls: string[]): Promise<CodeLink[]> {
    const links: CodeLink[] = [];
    for (const url of urls.map(u => u.trim()).filter(Boolean)) {
      try { links.push(await fetchGithub(url, this.fetcher)); }
      catch (error) { const repo = parsePaperLink(url); links.push({ url: repo.url, fetchError: (error as Error).message } as CodeLink); }
    }
    return links;
  }

  /** Re-reads arXiv / GitHub metadata; keeps the researcher's title, notes, tags, status, and PDF. */
  async refreshPaper(id: string, edit: { expectedRevision: number; expectedHash: string; actor?: 'agent' | 'human' }) {
    const paper = this.store.get(id);
    if (paper.kind !== 'Paper') throw new Error('Only papers have fetched metadata.');
    const metadata: Record<string, any> = { ...paper.metadata };
    if (metadata.arxivId) { const { title: _t, ...fetched } = await fetchArxiv(metadata.arxivId, this.fetcher); Object.assign(metadata, fetched); delete metadata.fetchError; }
    metadata.code = await this.codeLinks((metadata.code || []).map((c: CodeLink) => c.url));
    return this.store.update(id, { metadata }, edit);
  }

  async fetchPaperPdf(id: string, edit: { expectedRevision: number; expectedHash: string; actor?: 'agent' | 'human' }) {
    const paper = this.store.get(id);
    if (paper.kind !== 'Paper' || !paper.metadata.pdfUrl) throw new Error('Only arXiv papers can download their PDF automatically. Upload the PDF instead.');
    return this.store.attachPaperPdf(id, await downloadPdf(paper.metadata.pdfUrl, this.fetcher), `${paper.metadata.arxivId || id}.pdf`, edit);
  }

  private rememberRun(run: Awaited<ReturnType<typeof prepareRun>>) {
    this.managedRuns = [run, ...this.managedRuns.filter(previous => previous.requestId !== run.requestId)]
      .sort((a,b) => b.preparedAt.localeCompare(a.preparedAt));
  }

  async prepare(spec: RunSpec) {
    const experiment = this.store.get(spec.experimentId);
    if (experiment.kind !== 'Experiment' || !experiment.body.trim()) throw new Error('Create an experiment brief before preparing a run.');
    if (!experiment.projectIds.includes(spec.projectId)) throw new Error('Experiment does not belong to this project.');
    return prepareRun(this.store.root,{...spec,experimentBrief:{id:experiment.id,revision:experiment.revision,contentHash:experiment.contentHash!,title:experiment.title,body:experiment.body,metadata:experiment.metadata,links:experiment.links}});
  }

  async mergeIdeas(sourceId: string,targetId: string,expectedRevision?: number,expectedHash?: string) {
    if (sourceId === targetId) throw new Error('Choose a different target idea.');
    const source = this.store.get(sourceId), target = this.store.get(targetId);
    if (source.kind !== 'Idea' || target.kind !== 'Idea') throw new Error('Only ideas can be merged.');
    return this.store.update(sourceId,{status:'Merged',links:[...source.links.filter(l => l.relation !== 'mergedInto'),{target:targetId,relation:'mergedInto'}],metadata:{...source.metadata,mergedInto:targetId} },this.displayedEdit({id:sourceId,expectedRevision,expectedHash}));
  }

  async report(push: boolean) {
    const report = this.project()?.metadata.report;
    if (!report?.path) throw new Error('Link an Overleaf clone in project settings.');
    const result = await (push ? pushReport : syncReport)(report.path,report.remote || 'origin');
    return this.rememberReport(report, result);
  }

  private reportKey(report: {path:string;remote?:string}) {
    return JSON.stringify([path.resolve(report.path), report.remote || 'origin']);
  }

  private rememberReport(report: {path:string;remote?:string}, result: Awaited<ReturnType<typeof readReportStatus>>) {
    const key = this.reportKey(report);
    const previous = this.reportChecks.get(key);
    const saved = { ...result, lastSyncedAt: result.lastSyncedAt ?? previous?.lastSyncedAt };
    this.reportChecks.set(key, saved);
    this.reportStatuses.set(key, saved);
    return saved;
  }

  async syncReports() {
    for (const project of this.store.list(undefined,'Project')) {
      const report = project.metadata.report;
      if (report?.path) this.rememberReport(report,await syncReport(report.path,report.remote || 'origin').catch(e=>({repo:report.path,branch:'',remote:report.remote || 'origin',state:'error' as const,ahead:0,behind:0,changedFiles:[],message:e.message})));
    }
  }

  async loadDrive(options: {query?:string;mimeType?:string;projectId?:string} = {}) {
    if (!this.drive) throw new Error('Connect Google Drive first.');
    const project = options.projectId === undefined ? this.project() : this.store.get(options.projectId);
    if (project && project.kind !== 'Project') throw new Error('Choose a research project before loading Drive files.');
    const projectId = project?.id || '';
    const folders = project?.metadata.driveFolders || [];
    if (!folders.length) throw new Error('Add a Drive folder ID in project settings.');
    const files = [], errors: string[] = [];
    for (const folder of folders) {
      const id = typeof folder === 'string' ? folder : folder.id;
      try { files.push(...await this.drive.listFolder(id,{query:options.query,mimeType:options.mimeType,recursive:true})); }
      catch (e) {
        const error = e as Error & {partialFiles?:any[]};
        let message = error.message;
        if (error.partialFiles) files.push(...error.partialFiles);
        if (e instanceof DriveError && ['network', 'api'].includes(e.code)) {
          const cached = this.drive.getCachedFiles(id);
          if (cached) { files.unshift(...cached.files); message += ` Showing cached files from ${cached.fetchedAt}.`; }
        }
        errors.push(message);
        if (e instanceof DriveError && e.code === 'auth') break;
      }
    }
    if (errors.length) this.driveErrors.set(projectId, errors.join('\n'));
    else this.driveErrors.delete(projectId);
    if (this.project()?.id === projectId) this.files = [...new Map(files.map(f => [f.id,f])).values()].filter(file =>
      (!options.query || file.name.toLowerCase().includes(options.query.toLowerCase())) && (!options.mimeType || file.mimeType === options.mimeType));
  }

  async linkDrive(fileId: string,entityId: string) {
    const file = this.files.find(f => f.id === fileId);
    if (!file) throw new Error('Load the Drive file before linking it.');
    const e = this.store.get(entityId);
    const url = file.webViewLink || `https://drive.google.com/open?id=${encodeURIComponent(file.id)}`;
    return this.store.update(entityId,{sources:[...e.sources.filter(s => s.url !== url),{url,label:file.name}]},this.edit(entityId));
  }

  async refresh() {
    this.operationalErrors = [];
    await this.store.reindex();
    await refreshRuns(this.store.root).then(runs => { this.managedRuns = runs; }).catch(e => this.operationalErrors.push(`Managed runs: ${e.message}`));
    try {
      const {stdout} = await execute('squeue',['-h','-u',os.userInfo().username,'-o','%i|%100j|%T|%P|%M'],{timeout:10000,maxBuffer:1024*1024});
      const projects = this.store.list(undefined,'Project');
      this.observedJobs = stdout.trim().split('\n').filter(Boolean).flatMap(line => {
        const [jobId,name,state,partition,elapsed] = line.split('|').map(v => v.trim());
        const project = projects.find(p => p.metadata.jobNamePrefix && name.startsWith(p.metadata.jobNamePrefix));
        return project ? [{requestId:`observed-${jobId}`,jobId,projectId:project.id,experimentId:'',state,legacy:true,readOnly:true,name,elapsed,spec:{resources:{partition},command:[]},units:[]}] : [];
      });
    } catch (e) { this.operationalErrors.push(`Slurm status unavailable: ${(e as Error).message.split('\n')[0]}`); }
    await this.loadSection({force:true});
  }
}
