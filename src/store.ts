import { promises as fs, statfsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import YAML from 'yaml';
import { paperStatuses, type Entity, type EntityKind } from './types.js';
import { canBackBurner, card, isBackBurner, missingFromMainline, outline, primaryHandoff, validateBackBurner, type BackBurner } from './workflow.js';

const kinds = ['Project', 'Idea', 'Claim', 'Experiment', 'Artifact', 'Note', 'Paper'];
export const PDF_LIMIT = 50 * 1024 * 1024;
const statuses = ['Open', 'Supported', 'Mixed', 'Refuted'];
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const safeId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(id);
export class ConflictError extends Error { code = 'CONFLICT'; }
export type Edit = { expectedRevision: number; expectedHash: string; actor?: 'agent' | 'human' };

function decode(raw: string, filePath: string): Entity {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) throw new Error('Missing YAML frontmatter');
  const data = YAML.parse(match[1]);
  const entity = { ...data, body: match[2].trim(), filePath, contentHash: hash(raw) } as Entity;
  validate(entity);
  return entity;
}

function validate(e: Entity) {
  if (!e || !safeId(e.id) || !kinds.includes(e.kind) || typeof e.title !== 'string' || !e.title.trim()) throw new Error('Invalid record identity or title');
  if (!Number.isInteger(e.revision) || e.revision < 1) throw new Error('Invalid revision');
  if (!Array.isArray(e.projectIds) || !e.projectIds.every(safeId)) throw new Error('Invalid project IDs');
  if (!Array.isArray(e.links) || !e.links.every(l => safeId(l.target) && typeof l.relation === 'string')) throw new Error('Invalid links');
  if (!Array.isArray(e.sources) || !e.sources.every(s => typeof s === 'object' && s !== null)) throw new Error('Invalid sources');
  if (typeof e.body !== 'string' || typeof e.metadata !== 'object' || e.metadata === null) throw new Error('Invalid record content');
  if (e.kind === 'Claim' && !statuses.includes(e.status)) throw new Error('Invalid claim status');
  if (e.kind === 'Paper') validatePaper(e);
  validateBackBurner(e);
}

function validatePaper(e: Entity) {
  if (e.projectIds.length !== 1) throw new Error('A paper belongs to exactly one project. Add a separate copy to another project.');
  if (!(paperStatuses as readonly string[]).includes(e.status)) throw new Error(`Paper status must be one of: ${paperStatuses.join(', ')}`);
  const m = e.metadata;
  if (m.authors !== undefined && !(Array.isArray(m.authors) && m.authors.every((a: unknown) => typeof a === 'string'))) throw new Error('Paper authors must be a list of names');
  if (m.tags !== undefined && !(Array.isArray(m.tags) && m.tags.every((t: unknown) => typeof t === 'string'))) throw new Error('Paper tags must be a list of words');
  if (m.code !== undefined && !(Array.isArray(m.code) && m.code.every((c: any) => c && typeof c.url === 'string'))) throw new Error('Paper code links need a url');
  for (const url of [m.paperUrl, ...(m.code || []).map((c: any) => c.url)].filter(Boolean)) {
    if (!/^https?:\/\//.test(String(url))) throw new Error('Paper and code links must be web links');
  }
  if (m.pdf !== undefined && !(typeof m.pdf?.path === 'string' && m.pdf.path.startsWith('library/') && !m.pdf.path.includes('..'))) throw new Error('Paper PDF must be stored under the memory library folder');
}

function encode(entity: Entity) {
  const { body, filePath: _path, contentHash: _hash, ...meta } = entity;
  return `---\n${YAML.stringify(meta)}---\n\n${body.trim()}\n`;
}

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.filter(e => !e.name.startsWith('.')).map(async e => {
    const location = path.join(dir, e.name);
    return e.isDirectory() ? walk(location) : e.isFile() && e.name.endsWith('.md') && e.name !== 'readme.md' ? [location] : [];
  }));
  return nested.flat();
}

export class ResearchStore {
  readonly root: string;
  readonly cacheRoot: string;
  db!: DatabaseSync;
  errors: string[] = [];
  private indexing: Promise<void> = Promise.resolve();
  constructor(root: string, cacheRoot?: string) {
    this.root = path.resolve(root);
    this.cacheRoot = cacheRoot || path.join('/tmp', `research-manager-${os.userInfo().uid}`, hash(this.root).slice(0, 16));
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true });
    await fs.mkdir(path.join(this.root, 'records'), { recursive: true });
    await fs.mkdir(this.cacheRoot, { recursive: true, mode: 0o700 });
    if (Number(statfsSync(this.cacheRoot).type) === 0x6969) throw new Error('SQLite cache must be on local disk, not NFS');
    this.db = new DatabaseSync(path.join(this.cacheRoot, 'index.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, file TEXT UNIQUE, hash TEXT, json TEXT); CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(id UNINDEXED,title,body);');
    await this.reindex();
    return this;
  }

  close() { this.db?.close(); }

  reindex() {
    const scan = this.indexing.then(() => this.scanRecords());
    this.indexing = scan.catch(() => {});
    return scan;
  }

  private async scanRecords() {
    this.errors = [];
    const files = await walk(path.join(this.root, 'records'));
    const seen = new Set<string>();
    for (const file of files) {
      try {
        const raw = await fs.readFile(file, 'utf8');
        const existing = this.db.prepare('SELECT id,hash FROM records WHERE file=?').get(file);
        if (existing?.hash === hash(raw)) continue;
        const entity = decode(raw, file);
        if (existing && existing.id !== entity.id) throw new Error(`Record ID changed from ${existing.id} to ${entity.id}. Restore its stable ID; renaming a file does not rename its record.`);
        if (seen.has(entity.id)) throw new Error(`Duplicate ID ${entity.id}`);
        seen.add(entity.id);
        const other = this.db.prepare('SELECT file FROM records WHERE id=?').get(entity.id);
        if (other && other.file !== file && files.includes(String(other.file))) throw new Error(`Duplicate ID ${entity.id}`);
        this.db.exec('BEGIN IMMEDIATE');
        try {
          this.db.prepare('DELETE FROM search WHERE id=?').run(entity.id);
          this.db.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?,?)').run(entity.id, file, entity.contentHash!, JSON.stringify(entity));
          this.db.prepare('INSERT INTO search VALUES(?,?,?)').run(entity.id, entity.title, entity.body);
          this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      } catch (error) { this.errors.push(`${file}: ${(error as Error).message}`); }
    }
    for (const row of this.db.prepare('SELECT id,file FROM records').all()) {
      if (!files.includes(String(row.file))) {
        this.db.prepare('DELETE FROM records WHERE id=?').run(row.id);
        this.db.prepare('DELETE FROM search WHERE id=?').run(row.id);
      }
    }
  }

  list(projectId?: string, kind?: EntityKind): Entity[] {
    return this.reviewState(this.indexed())
      .filter(e => (!projectId || e.id === projectId || e.projectIds.includes(projectId)) && (!kind || e.kind === kind));
  }

  get(id: string) {
    const entity = this.list().find(record => record.id === id);
    if (!entity) throw new Error(`Record not found: ${id}`);
    return entity;
  }

  private indexed(): Entity[] {
    return this.db.prepare('SELECT json FROM records ORDER BY id').all().map(row => JSON.parse(String(row.json)) as Entity);
  }

  private evidence(records: Entity[]): Map<string, Entity[]> {
    const byId = new Map(records.map(record => [record.id, record]));
    const dependencies = new Map<string, Set<string>>();
    const depend = (owner: string, target: string) => {
      if (!dependencies.has(owner)) dependencies.set(owner, new Set());
      dependencies.get(owner)!.add(target);
    };
    for (const record of records) for (const link of record.links) {
      const target = byId.get(link.target);
      if (!target) continue;
      const relation = link.relation.replaceAll('-', '_');
      if (record.kind === 'Claim' && ['evidence', 'subclaim', 'condition'].includes(relation) && ['Claim', 'Experiment', 'Artifact'].includes(target.kind)) depend(record.id, target.id);
      if (record.kind === 'Experiment' && target.kind === 'Artifact' && ['produced', 'produces', 'baseline', 'evidence'].includes(relation)) depend(record.id, target.id);
      if (record.kind === 'Experiment' && target.kind === 'Claim' && ['tests', 'supports', 'refutes'].includes(relation)) depend(target.id, record.id);
      if (record.kind === 'Artifact' && target.kind === 'Claim' && ['supports', 'refutes'].includes(relation)) depend(target.id, record.id);
      if (record.kind === 'Claim' && target.kind === 'Claim' && relation === 'subclaim_of') depend(target.id, record.id);
      if (record.kind === 'Artifact' && target.kind === 'Experiment' && relation === 'produced_by') depend(target.id, record.id);
    }
    const result = new Map<string, Entity[]>();
    for (const claim of records.filter(record => record.kind === 'Claim')) {
      const seen = new Set<string>(), pending = [...(dependencies.get(claim.id) ?? [])], artifacts: Entity[] = [];
      while (pending.length) {
        const id = pending.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        const record = byId.get(id);
        if (record?.kind === 'Artifact') artifacts.push(record);
        pending.push(...(dependencies.get(id) ?? []));
      }
      result.set(claim.id, artifacts);
    }
    return result;
  }

  private reviewState(records: Entity[]): Entity[] {
    const evidence = this.evidence(records);
    for (const claim of records.filter(record => record.kind === 'Claim')) {
      const artifacts = evidence.get(claim.id) ?? [];
      const acknowledged = claim.metadata.review?.evidenceVersions as Record<string, string> | undefined;
      const current = new Map(artifacts.map(artifact => [artifact.id, artifact.contentHash!]));
      const changed = artifacts.filter(artifact => (artifact.status === 'Invalid' || acknowledged) && acknowledged?.[artifact.id] !== artifact.contentHash);
      const removed = Object.keys(acknowledged ?? {}).filter(id => !current.has(id));
      if (changed.length || removed.length) claim.metadata = {
        ...claim.metadata, needsReview: true,
        reviewReason: `Evidence changed: ${[...changed.map(artifact => artifact.id), ...removed].join(', ')}. Review the judgment before citing this claim.`,
      };
    }
    return records;
  }

  search(query: string, projectId?: string, limit = 100) {
    const tokens = query.match(/[\p{L}\p{N}_-]+/gu) || [];
    if (!tokens.length) return this.list(projectId);
    const byId = new Map(this.list(projectId).map(e => [e.id, e]));
    const ranked = this.db.prepare('SELECT id FROM search WHERE search MATCH ? ORDER BY bm25(search, 0.0, 10.0, 1.0)').all(tokens.map(t => `"${t.replaceAll('"', '""')}"*`).join(' AND ')).map(r => byId.get(String(r.id))).filter((e): e is Entity => !!e);
    const exact = query.trim().toLowerCase();
    return [...ranked.filter(e => e.title.toLowerCase() === exact), ...ranked.filter(e => e.title.toLowerCase() !== exact)].slice(0, limit);
  }

  async create(input: Partial<Entity>, actor: 'agent' | 'human' = 'agent') {
    const now = new Date().toISOString();
    const entity: Entity = { id: input.id || `${(input.kind || 'Note').toLowerCase()}-${randomUUID()}`, kind: input.kind || 'Note', title: input.title || '', projectIds: input.projectIds || [], status: input.kind === 'Claim' ? 'Open' : input.status || (input.kind === 'Paper' ? 'To read' : 'Inbox'), revision: 1, createdAt: now, updatedAt: now, links: input.links || [], sources: input.sources || [], metadata: { ...input.metadata, author: actor }, body: input.body || '' };
    validate(entity);
    if (entity.kind === 'Claim' && actor !== 'human' && entity.metadata.review !== undefined) throw new Error('Human review metadata is protected. Add a proposal note instead.');
    if (actor !== 'human') {
      if (entity.kind === 'Claim' && input.status !== undefined && input.status !== 'Open') throw new Error('Claims start Open. Propose a verdict with research_propose_verdict; the researcher sets it.');
      if (entity.kind === 'Note' && (entity.status === 'Reviewed' || 'reviewedStatus' in entity.metadata || 'reviewedAt' in entity.metadata)) throw new Error('A Reviewed note comes only from the researcher reviewing a claim.');
      if (entity.kind === 'Artifact' && entity.status === 'Invalid') throw new Error('Create the artifact as Available, then mark its evidence invalid with a reason.');
    }
    return this.lock(entity.id, async () => {
      await this.reindex();
      if (this.db.prepare('SELECT id FROM records WHERE id=?').get(entity.id)) throw new ConflictError(`Record ${entity.id} already exists.`);
      const target = path.join(this.root, 'records', `${entity.id}.md`);
      await fs.writeFile(target, encode(entity), { flag: 'wx' });
      await this.reindex();
      return this.get(entity.id);
    });
  }

  async update(id: string, patch: Partial<Entity>, edit: Edit) {
    return this.change(id, edit, () => patch);
  }

  private async change(id: string, edit: Edit, patchFor: (current: Entity) => Partial<Entity>) {
    return this.lock(id, async () => {
      await this.reindex();
      const indexed = this.get(id);
      const raw = await fs.readFile(indexed.filePath!, 'utf8');
      const current = decode(raw, indexed.filePath!);
      if (current.revision !== edit.expectedRevision || current.contentHash !== edit.expectedHash) throw new ConflictError(`Record ${id} changed. Read it again before editing.`);
      const patch = patchFor(current);
      if (current.kind === 'Claim' && patch.status && patch.status !== current.status && edit.actor !== 'human') throw new Error('Only a human review can change a claim verdict. Add a proposal note instead.');
      if (edit.actor !== 'human') {
        const editable = current.kind === 'Note' && current.status === 'Proposed' ? ['title', 'body', 'sources'] : current.kind === 'Note' && current.status === 'Reviewed' ? ['sources'] : undefined;
        if ((editable && Object.keys(patch).some(key => !editable.includes(key))) || (current.kind === 'Note' && (patch.status === 'Reviewed' || ['reviewedStatus', 'reviewedAt'].some(key => patch.metadata && key in patch.metadata))))
          throw new Error('Only the researcher closes a verdict proposal, by reviewing its claim. An agent may edit only the title, body, and sources of an open proposal, and only the sources of a reviewed one.');
        if (current.kind === 'Artifact' && current.status === 'Invalid' && patch.status && patch.status !== 'Invalid') throw new Error('Only the researcher can restore invalidated evidence.');
        if (patch.projectIds && JSON.stringify(patch.projectIds) !== JSON.stringify(current.projectIds)) {
          for (const project of patch.projectIds) if (!this.list(project).length) throw new Error(`Unknown project: ${project}.`);
          if (current.kind === 'Claim' && this.openProposal(id)) throw new Error('This claim has an open verdict proposal; the researcher reviews it before it moves between projects.');
        }
      }
      if (current.kind === 'Claim' && edit.actor !== 'human' && patch.metadata) {
        if ('review' in patch.metadata && JSON.stringify(patch.metadata.review) !== JSON.stringify(current.metadata.review)) throw new Error('Human review metadata is protected. Add a proposal note instead.');
        if (indexed.metadata.needsReview && 'needsReview' in patch.metadata && patch.metadata.needsReview !== true) throw new Error('Only a human review can clear Needs review.');
      }
      const next: Entity = { ...current, ...patch, metadata: { ...current.metadata, ...patch.metadata }, id, kind: current.kind, revision: current.revision + 1, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
      validate(next);
      const history = path.join(this.root, 'history', id);
      await fs.mkdir(history, { recursive: true });
      await fs.writeFile(path.join(history, `${current.revision}-${current.contentHash!.slice(0, 12)}.md`), raw, { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
      const temp = `${current.filePath}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, encode(next));
        if (hash(await fs.readFile(current.filePath!, 'utf8')) !== current.contentHash) throw new ConflictError('File changed while the update was being prepared');
        await fs.rename(temp, current.filePath!);
      } finally { await fs.rm(temp, { force: true }); }
      await this.reindex();
      return this.get(id);
    });
  }

  /** Absolute path of a paper's stored PDF (inside the memory folder), or undefined. */
  paperPdfPath(paper: Entity) {
    const rel = paper.metadata.pdf?.path;
    if (typeof rel !== 'string') return undefined;
    const target = path.resolve(this.root, rel);
    if (!target.startsWith(path.join(this.root, 'library') + path.sep)) throw new Error('Paper PDF path is outside the memory library');
    return target;
  }

  /** Stores a PDF for a Paper under library/<project>/<id>.pdf (excluded from Git) and records its identity. */
  async attachPaperPdf(id: string, bytes: Buffer, originalName: string, edit: Edit) {
    const paper = this.get(id);
    if (paper.kind !== 'Paper') throw new Error('Only papers have a stored PDF');
    if (!bytes.length || bytes.length > PDF_LIMIT) throw new Error(`A PDF must be between 1 byte and ${PDF_LIMIT / 1024 / 1024} MB`);
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('This file is not a PDF');
    const rel = path.posix.join('library', paper.projectIds[0], `${id}.pdf`);
    const target = path.join(this.root, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temp, bytes); await fs.rename(temp, target); } finally { await fs.rm(temp, { force: true }); }
    const pdf = { path: rel, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, originalName: path.basename(originalName || 'paper.pdf'), addedAt: new Date().toISOString() };
    return this.update(id, { metadata: { ...paper.metadata, pdf } }, edit);
  }

  /** An unreviewed proposal note pointing at this claim, if any. */
  openProposal(claimId: string) {
    return this.list().find(note => note.kind === 'Note' && note.status === 'Proposed' && note.links.some(link => link.target === claimId && link.relation === 'proposes'));
  }

  async setBackBurner(id: string, active: boolean, reason: string, edit: Edit, why: Pick<BackBurner, 'category' | 'supersededBy'> = {}) {
    if (active && edit.actor !== 'human' && this.openProposal(id)) throw new Error('This claim has an open verdict proposal; the researcher reviews it before it can move to the back burner.');
    if (typeof active !== 'boolean' || typeof reason !== 'string') throw new Error('Back burner requires a boolean active flag and a text reason.');
    if (active && why.category === 'superseded' && !why.supersededBy) throw new Error('A superseded record needs supersededBy: the record that replaces it.');
    if (why.supersededBy === id) throw new Error('A record cannot supersede itself.');
    if (why.supersededBy && why.category !== 'superseded' && why.category !== 'merged') throw new Error('supersededBy needs category superseded or merged.');
    if (why.supersededBy) this.get(why.supersededBy);
    const existing = this.get(id);
    if (canBackBurner(existing) && isBackBurner(existing) === active && (!active || (existing.metadata.backBurner?.reason === reason.trim() && existing.metadata.backBurner?.category === why.category && existing.metadata.backBurner?.supersededBy === why.supersededBy))) return existing;
    return this.change(id, edit, current => {
      if (!canBackBurner(current)) throw new Error('Only ideas, experiments, and claims can move to the back burner.');
      const now = new Date().toISOString(), by = edit.actor ?? 'agent';
      const previous = current.metadata.backBurner as BackBurner | undefined;
      const backBurner: BackBurner = active
        ? { active: true, reason: reason.trim(), ...(why.category ? { category: why.category } : {}), ...(why.supersededBy ? { supersededBy: why.supersededBy } : {}), at: now, by, previousStatus: current.status }
        : { ...(previous ?? { reason: '', at: current.updatedAt, by, previousStatus: current.status }), active: false, restoredAt: now, restoredBy: by, ...(reason.trim() ? { restoreReason: reason.trim() } : {}) };
      const status = !active && current.status === 'Parked'
        ? (previous?.previousStatus && previous.previousStatus !== 'Parked' ? previous.previousStatus : 'Open')
        : current.status;
      return { status, metadata: { backBurner } };
    });
  }

  async lock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (!safeId(id)) throw new Error('Invalid record ID');
    const lockPath = path.join(this.root, '.locks', id);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    let acquired = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        await fs.mkdir(lockPath);
        acquired = true;
        await fs.writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() }));
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    if (!acquired) throw new ConflictError(`Record ${id} is locked. Retry after the other writer finishes; stale locks need owner verification.`);
    try { return await operation(); } finally { await fs.rm(lockPath, { recursive: true, force: true }); }
  }

  /** A candidate verdict as a Proposed Note; never changes the claim. */
  async proposeVerdict(claimId: string, status: string, reason: string) {
    const claim = this.get(claimId);
    if (claim.kind !== 'Claim') throw new Error(`Not a claim: ${claimId}`);
    if (!statuses.includes(status) || !reason.trim()) throw new Error('A proposal needs a status (Open, Supported, Mixed, Refuted) and a reason.');
    return this.create({ kind: 'Note', title: `Review proposal: ${claim.title}`, body: reason, status: 'Proposed', projectIds: claim.projectIds, links: [{ target: claim.id, relation: 'proposes' }], metadata: { role: 'Interpretation', proposedStatus: status } });
  }

  async reviewClaim(id: string, status: string, reason: string, edit: Edit) {
    if (!reason.trim()) throw new Error('A review reason is required');
    await this.reindex();
    const e = this.get(id);
    if (e.kind !== 'Claim') throw new Error('Only claims have verdicts');
    const evidenceVersions = Object.fromEntries((this.evidence(this.indexed()).get(id) ?? []).map(artifact => [artifact.id, artifact.contentHash]));
    const reviewed = await this.update(id, { status, metadata: { ...e.metadata, needsReview: false, reviewReason: '', review: { status, reason, evidenceVersions, at: new Date().toISOString(), by: 'human' } } }, { ...edit, actor: 'human' });
    for (const note of this.list().filter(note => note.kind === 'Note' && note.status === 'Proposed' && note.links.some(link => link.target === id && link.relation === 'proposes')))
      await this.update(note.id, { status: 'Reviewed', metadata: { ...note.metadata, reviewedAt: reviewed.updatedAt, reviewedStatus: status } }, { expectedRevision: note.revision, expectedHash: note.contentHash!, actor: 'human' });
    return reviewed;
  }

  async invalidateArtifact(id: string, reason: string, edit: Edit) {
    if (!reason.trim()) throw new Error('An invalidation reason is required');
    const artifact = this.get(id);
    if (artifact.kind !== 'Artifact') throw new Error('Only artifacts can be invalidated');
    return this.update(id, { status: 'Invalid', metadata: { ...artifact.metadata, invalidationReason: reason } }, edit);
  }

  // Compact by default: overview, primary handoff, mainline cards, and active changes since that handoff.
  handoff(projectId: string) {
    const records = this.list(projectId);
    const project = records.find(e => e.id === projectId && e.kind === 'Project');
    if (!project && !records.length) throw new Error(`Unknown project: ${projectId}`);
    const note = primaryHandoff(project, records);
    const byId = new Map(records.map(e => [e.id, e]));
    const researchFlow = project?.metadata.researchFlow?.version === 1 ? project.metadata.researchFlow : undefined;
    const flow: string[] | undefined = [researchFlow?.overviewNodeIds, researchFlow?.nodeIds].find(Array.isArray);
    const mainline = flow ? flow.filter(id => byId.has(id)).map(id => card(byId.get(id)!)) : records.filter(e => e.kind === 'Claim').map(card);
    const changed = records.filter(e => e !== project && e !== note && !isBackBurner(e) && e.updatedAt > (note?.updatedAt ?? '')).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const counts: Record<string, Record<string, number>> = {};
    for (const e of records) { counts[e.kind] ??= {}; counts[e.kind][e.status] = (counts[e.kind][e.status] ?? 0) + 1; }
    return { projectId, generatedAt: new Date().toISOString(), detail: 'compact',
      project: project && { ...card(project), sections: outline(project.body), sourceCount: project.sources.length },
      handoff: note && { ...card(note), pinned: note.id === project?.metadata.researchFlow?.handoffId, body: note.body, sources: [...new Set(note.sources.map(s => s.path ?? s.url ?? s.label))].filter(Boolean), links: note.links },
      mainline, unresolvedMainline: flow?.filter(id => !byId.has(id)) ?? [], notOnMainline: project ? missingFromMainline(project, records).map(card) : [],
      changedSinceHandoff: changed.slice(0, 20).map(card), changedTotal: changed.length,
      newerHandoffs: note ? records.filter(e => e !== note && e.kind === 'Note' && e.metadata.role === 'Handoff' && e.updatedAt > note.updatedAt).map(card) : [],
      backBurner: records.filter(isBackBurner).length, counts,
      next: 'research_get (CLI: get ID) for a full record; research_search (CLI: search QUERY PROJECT) for cards; research_context for one claim.',
      errors: this.errors };
  }

  fullHandoff(projectId: string) {
    const records = this.list(projectId);
    return { projectId, generatedAt: new Date().toISOString(), records: records.map(e => ({ id: e.id, kind: e.kind, title: e.title, status: e.status, placement: isBackBurner(e) ? 'Back burner' : 'Active', body: e.body, metadata: e.metadata, sources: e.sources, links: e.links, filePath: e.filePath })), errors: this.errors };
  }
}
