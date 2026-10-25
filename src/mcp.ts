import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { ResearchStore } from './store.js';
import type { ResearchService } from './service.js';
import type { Entity, EntityKind } from './types.js';
import { backBurnerCategories, card, statusesByKind } from './workflow.js';
import { lint } from './lint.js';
import { claimContext } from './context.js';
import { guides, readGuide } from './guides.js';
import { listRuns, submitRun, refreshRuns, reconcileSubmission } from './runs.js';
import { buildCodeGraph } from './integrations/code-map.js';
import { readReport, readReportStatus, reportOutline, syncReport } from './integrations/report.js';

// Tool design follows the MCP tools spec and Anthropic's "Writing effective tools for agents": one job per tool,
// described parameters, compact high-signal results with paging, actionable errors, honest annotations,
// and a --read-only mode that registers no write tools.
const instructions = `Research Manager is a shared research memory of Markdown records (Project, Claim, Experiment, Note, Artifact, Idea, Paper).
- Start a session with research_handoff. Read one claim's evidence with research_context instead of the whole project.
- Before writing a record or code, read its guide with research_guide (experiment, project-overview, related-work, back-burner, report-and-files, ponytail).
- Writes need the revision and contentHash from your last read. On a conflict, research_get the record, merge, retry.
- Never set a claim's status; propose with research_propose_verdict. Move records to the back burner or submit runs only with the researcher's agreement.
- Run research_lint before you finish and end with a Handoff note.`;

const readOnlyInstructions = `Research Manager (read-only connection): a shared research memory of Markdown records (Project, Claim, Experiment, Note, Artifact, Idea, Paper). This server cannot write.
- Start with research_handoff. Read one claim's evidence with research_context. Use research_lint to see what needs a decision.
- Report findings to the researcher; any change must go through a writable connection.`;

const kinds = ['Project', 'Idea', 'Claim', 'Experiment', 'Artifact', 'Note', 'Paper'] as const;
const id = z.string().describe('Record id, e.g. "claim-demo-routing" (from research_search or research_handoff)');
const projectId = z.string().describe('Project id, e.g. "project-demo"');
const expected = {
  expectedRevision: z.number().int().describe('revision from your last read of this record'),
  expectedHash: z.string().describe('contentHash from your last read of this record'),
};
const link = z.object({ target: z.string().describe('Target record id'), relation: z.string().describe('e.g. tests, evidence, discusses, produced, child_of, next_question, builds_on, baseline, compares_with') });
const source = z.object({ path: z.string().optional().describe('Absolute file path'), url: z.string().optional(), label: z.string().optional(), line: z.number().int().optional() }).passthrough();
const fields = {
  title: z.string().describe('Short title; claims and experiments ≤ 45 characters'),
  status: z.string().describe(`Allowed per kind: ${Object.entries(statusesByKind).filter(([k]) => k !== 'Claim').map(([k, v]) => `${k}: ${v.filter(s => s !== 'Reviewed' && s !== 'Invalid').join('/')}`).join('; ')}. Claims start Open and only the researcher changes them.`),
  body: z.string().describe('Markdown body with the sections its research_guide asks for'),
  links: z.array(link).describe('Replaces the whole list on update'),
  sources: z.array(source).describe('Files or URLs the record relies on; replaces the whole list on update'),
  metadata: z.record(z.any()).describe('e.g. {"role": "Observation"} for notes, {"answer": "…"} for claims. On update keys merge; null deletes a key'),
};

/** What a write returns: enough to identify the record and write again, without echoing its body. */
const brief = (entity: Entity) => ({ ...card(entity), revision: entity.revision, contentHash: entity.contentHash, ...(entity.metadata.backBurner ? { backBurner: entity.metadata.backBurner } : {}) });

function hint(error: Error & { code?: string }) {
  if (error.code === 'CONFLICT') return ' Call research_get for this id to get the current revision and contentHash, merge your change into it, and retry.';
  if (/Record not found|Not a claim/.test(error.message)) return ' Find the right id with research_search.';
  if (/Unknown project/.test(error.message)) return ' List projects with research_search {"kind": "Project"}.';
  return '';
}

export async function serveMcp(store: ResearchStore, service: ResearchService, options: { readOnly?: boolean } = {}) {
  const server = new McpServer({ name: 'research-manager', version: '0.1.9' }, { instructions: options.readOnly ? readOnlyInstructions : instructions });
  const wrap = (fn: (args: any) => Promise<any> | any) => async (args: any) => {
    try { await store.reindex(); return { content: [{ type: 'text' as const, text: JSON.stringify(await fn(args)) }] }; }
    catch (e) { return { isError: true, content: [{ type: 'text' as const, text: (e as Error).message.replace(/([^.!?])$/, '$1.') + hint(e as Error) }] }; }
  };
  const checkWrite = (record: { kind?: string; status?: string; projectIds?: string[]; id?: string }, current?: Entity) => {
    const kind = current?.kind ?? record.kind!;
    if (record.status !== undefined && record.status !== current?.status && !statusesByKind[kind]?.includes(record.status)) throw new Error(`Status "${record.status}" is not allowed for ${kind}. Use one of: ${statusesByKind[kind].join(', ')}.`);
    for (const project of record.projectIds ?? []) if (!(kind === 'Project' && project === record.id) && !store.list(project).length) throw new Error(`Unknown project: ${project}. Create the Project record first, or check the id.`);
  };
  const reportOf = (project: string) => {
    const report = store.get(project).metadata.report;
    if (!report?.path) throw new Error(`Project ${project} has no linked Overleaf clone. The researcher sets it in Project settings → Overleaf clone.`);
    return report as { path: string; remote?: string; mainFile?: string };
  };
  const known = (project?: string) => { if (project && !store.list(project).length) throw new Error(`Unknown project: ${project}`); return project; };
  const read = { readOnlyHint: true, openWorldHint: false };
  const write = (more: { destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean } = {}) => ({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, ...more });
  type Config = { title: string; description: string; inputSchema: Record<string, z.ZodTypeAny>; annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean } };
  const tool = (name: string, config: Config, handler: (args: any) => any) => {
    if (options.readOnly && !config.annotations.readOnlyHint) return;
    server.registerTool(name, config as any, wrap(handler) as any);
  };

  tool('research_handoff', { title: 'Project handoff', description: 'Start here. The compact state of one project: overview sections, the primary Handoff note in full (pinned by the project, else the latest; newerHandoffs lists any newer ones), mainline claim cards, claims the handoff discusses but the mainline omits, records changed since the handoff, and counts. detail "full" returns every record body (megabytes; avoid).',
    inputSchema: { projectId, detail: z.enum(['compact', 'full']).default('compact').describe('compact (default, ~20 KB) or full') }, annotations: read },
    a => a.detail === 'full' ? store.fullHandoff(known(a.projectId)!) : store.handoff(a.projectId));
  tool('research_search', { title: 'Search records', description: 'Find records as cards (id, kind, title, status, placement, one-paragraph summary), ranked by relevance with exact title matches first. Without query it lists records. Returns {total, offset, truncated, results}; page with offset. Use research_get for one full record.',
    inputSchema: { query: z.string().optional().describe('Words to match in titles and bodies; omit to list'), projectId: projectId.optional(), kind: z.enum(kinds).optional().describe('Only this record kind, e.g. Claim'),
      limit: z.number().int().min(1).max(200).default(20).describe('Results per page (default 20)'), offset: z.number().int().min(0).default(0).describe('Skip this many results'),
      detail: z.enum(['card', 'full']).default('card').describe('card (default) or full records') }, annotations: read },
    a => {
      const hits = (a.query ? store.search(a.query, known(a.projectId), Infinity) : store.list(known(a.projectId))).filter(e => !a.kind || e.kind === a.kind as EntityKind);
      const page = hits.slice(a.offset, a.offset + a.limit);
      return { total: hits.length, offset: a.offset, truncated: a.offset + page.length < hits.length, results: a.detail === 'full' ? page : page.map(card) };
    });
  tool('research_get', { title: 'Read one record', description: 'One full record: body, links, sources, metadata, revision and contentHash (needed to update it).', inputSchema: { id }, annotations: read }, a => store.get(a.id));
  tool('research_context', { title: 'Claim evidence', description: "The evidence around one claim: experiments that test it with their decision rule, result and rule-met; other cited experiments; observations' main finding and limits; interpretations; open proposals (with outdated flag); papers; neighbouring claims. Read this before judging or extending a claim.",
    inputSchema: { claimId: id.describe('Claim id'), limit: z.number().int().min(1).max(100).default(8).describe('Newest observations to include (default 8)') }, annotations: read }, a => claimContext(store.list(), a.claimId, a.limit));
  tool('research_lint', { title: 'Check project', description: 'Check a project against the writing guides. Returns grouped issues (error/warning/info), readyForVerdict claims, awaitingReview proposals, and backBurnerCandidates. Never changes records.',
    inputSchema: { projectId, full: z.boolean().default(false).describe('List every record per issue instead of the first 15') }, annotations: read },
    a => lint(store.list(), a.projectId, new Date(), a.full ? Infinity : undefined, paper => { const file = store.paperPdfPath(paper); return !!file && existsSync(file); }));
  tool('research_guide', { title: 'Writing guide', description: `The guide or skill to follow before writing that kind of record or code. Without name, lists them. ${Object.entries(guides).map(([name, g]) => `${name}: ${g.description}`).join(' ')}`,
    inputSchema: { name: z.enum(Object.keys(guides) as [string, ...string[]]).optional().describe('Guide name') }, annotations: read },
    async a => a.name ? { name: a.name, text: await readGuide(a.name) } : guides);
  tool('research_runs', { title: 'Recorded runs', description: 'Recorded experiment runs and their last known state, without contacting the scheduler. Use research_refresh_runs to poll Slurm.', inputSchema: {}, annotations: read }, () => listRuns(store.root));
  tool('research_code_map', { title: 'Code map', description: 'A source-linked map of Python and shell code under a repository, without executing it.',
    inputSchema: { sourceRoot: z.string().describe('Absolute path of the repository'), mode: z.enum(['data', 'modules']).default('data').describe('data flow or module structure') }, annotations: read },
    a => buildCodeGraph(a.sourceRoot, a.mode));

  tool('research_report_status', { title: 'Report status', description: "State of the project's Overleaf report clone: branch, state (clean/dirty/ahead/behind/diverged/offline/unconfigured), ahead/behind commits, changed files, and ignoredBuildFiles (LaTeX build output such as .aux/.log, which does not block sync). Local only: counts are as of lastFetchedAt; call research_report_sync to see new Overleaf edits.",
    inputSchema: { projectId }, annotations: read }, a => { const r = reportOf(a.projectId); return readReportStatus(r.path, r.remote || 'origin'); });
  tool('research_report_outline', { title: 'Report outline', description: 'The report\'s .tex/.bib files and every \\part…\\paragraph heading with file and line. Read this, then research_report_read one section.',
    inputSchema: { projectId }, annotations: read }, async a => { const r = reportOf(a.projectId); return { mainFile: r.mainFile ?? 'main.tex', ...await reportOutline(r.path) }; });
  tool('research_report_read', { title: 'Read report', description: 'One section of a report file (from its heading to the next heading of the same or higher level), or a line window. Returns the text with firstLine/lastLine (1-based) so you can edit the file with your own file tools; ambiguous titles are flagged.',
    inputSchema: { projectId, file: z.string().describe('Path inside the report, e.g. "main.tex" (from research_report_outline)'), section: z.string().optional().describe('Section title, exact or a unique part of it'), line: z.number().int().min(1).optional().describe('With section: the heading line (from the outline) when titles repeat'),
      offset: z.number().int().min(0).default(0).describe('Lines to skip (within the section if given)'), limit: z.number().int().min(1).max(2000).default(200).describe('Lines to return (default 200)') }, annotations: read },
    a => readReport(reportOf(a.projectId).path, a.file, { section: a.section, line: a.line, offset: a.offset, limit: a.limit }));
  tool('research_linked_files', { title: 'Linked files', description: "Drive and web files that the project's records cite in their sources, with the records citing each. Offline; it does not read Drive contents (use a Google Drive MCP server for that).",
    inputSchema: { projectId, query: z.string().optional().describe('Filter by file name or URL') }, annotations: read },
    a => {
      const files = new Map<string, { url: string; label?: string; kind: string; records: { id: string; title: string }[] }>();
      for (const record of store.list(known(a.projectId))) for (const s of record.sources) if (s.url && (!a.query || `${s.label ?? ''} ${s.url}`.toLowerCase().includes(a.query.toLowerCase()))) {
        const file = files.get(s.url) ?? { url: s.url, label: s.label, kind: /(^|\.)google\.com\//.test(s.url.replace(/^https?:\/\//, '')) && /drive|docs/.test(s.url) ? 'drive' : 'web', records: [] };
        file.records.push({ id: record.id, title: record.title });
        files.set(s.url, file);
      }
      return { total: files.size, files: [...files.values()] };
    });

  tool('research_create', { title: 'Create record', description: 'Create one record. Read research_guide for its kind first. Claims always start Open. Returns the new card with revision and contentHash.',
    inputSchema: { record: z.object({ kind: z.enum(kinds).describe('Record kind'), id: z.string().optional().describe('Stable id; generated when omitted'), projectIds: z.array(z.string()).describe('Projects it belongs to; a Paper has exactly one'),
      title: fields.title, status: fields.status.optional(), body: fields.body.optional(), links: fields.links.optional(), sources: fields.sources.optional(), metadata: fields.metadata.optional() }).describe('The record') }, annotations: write() },
    async a => { checkWrite(a.record); return brief(await store.create(a.record as Partial<Entity>)); });
  tool('research_update', { title: 'Update record', description: 'Change a record you have read. Only the fields you send change. History is kept, so nothing is lost. Agents cannot change a claim status or human review fields.',
    inputSchema: { id, patch: z.object({ title: fields.title.optional(), status: fields.status.optional(), body: fields.body.optional(), links: fields.links.optional(), sources: fields.sources.optional(), metadata: fields.metadata.optional(), addLinks: z.array(link).optional().describe('Links to append (instead of resending links)'), addSources: z.array(source).optional().describe('Sources to append (instead of resending sources)') }).strict().describe('Fields to change'), ...expected }, annotations: write() },
    async a => {
      const current = store.get(a.id), { addLinks, addSources, ...patch } = a.patch as any;
      const same = (x: object, y: object) => JSON.stringify(x) === JSON.stringify(y);
      if (addLinks) patch.links = [...(patch.links ?? current.links), ...addLinks.filter((l: object) => !(patch.links ?? current.links).some((o: object) => same(o, l)))];
      if (addSources) patch.sources = [...(patch.sources ?? current.sources), ...addSources.filter((s: { url?: string; path?: string }) => !(patch.sources ?? current.sources).some((o: { url?: string; path?: string }) => (s.url && o.url === s.url) || (s.path && o.path === s.path)))];
      checkWrite(patch, current);
      return brief(await store.update(a.id, patch, { expectedRevision: a.expectedRevision, expectedHash: a.expectedHash, actor: 'agent' }));
    });
  tool('research_propose_verdict', { title: 'Propose verdict', description: 'Suggest Supported, Mixed, Refuted or Open for a claim, with the deciding numbers in the reason. Creates a Proposed note for the researcher; never changes the claim.',
    inputSchema: { claimId: id.describe('Claim id'), status: z.enum(['Open', 'Supported', 'Mixed', 'Refuted']).describe('yes → Supported, partly → Mixed, no → Refuted'), reason: z.string().min(1).describe('Why, citing the experiments and numbers') }, annotations: write() },
    async a => brief(await store.proposeVerdict(a.claimId, a.status, a.reason)));
  tool('research_set_back_burner', { title: 'Back burner', description: 'Move an idea, experiment or claim to the back burner (active: true) or restore it (false). Repeating a move that is already in effect returns the record unchanged. Evidence, status, links and jobs are kept. Only after the researcher agrees; research_lint lists candidates.',
    inputSchema: { id, active: z.boolean().describe('true to shelve, false to restore'), reason: z.string().optional().describe('Why it can wait (or, when restoring, why it is back)'), category: z.enum(backBurnerCategories).optional().describe('superseded and merged need supersededBy'),
      supersededBy: z.string().optional().describe('Id of the record that replaces it'), ...expected }, annotations: write({ idempotentHint: true }) },
    async a => brief(await store.setBackBurner(a.id, a.active, a.reason ?? '', { expectedRevision: a.expectedRevision, expectedHash: a.expectedHash, actor: 'agent' }, { category: a.category, supersededBy: a.supersededBy })));
  tool('research_add_paper', { title: 'Add paper', description: "Add one related-work paper from its name or link, in one call (a paper already in the project is completed instead: missing PDF stored, unchecked code searched): finds it on arXiv (by title if you give a name), fills title/authors/abstract/BibTeX, stores the PDF in the memory library, and looks for its code in the abstract/comments, the PDF's links and Hugging Face Papers. Looks for code in the abstract/comments, the authors' project page, the PDF's links and Hugging Face Papers. Returns the PDF path and code.result: found (attached, each with foundIn), unconfirmed (only in the PDF's links, which also cite baselines: read the PDF, then research_set_paper_code), or none. Only titles, ids and links leave the machine.",
    inputSchema: { projectId, paper: z.string().describe('Paper name, arXiv id, arXiv link, or other paper URL'), title: z.string().optional().describe('Needed only for a non-arXiv URL'),
      codeUrls: z.array(z.string()).optional().describe('Code repositories you already know'), tags: z.array(z.string()).optional().describe('≤ 3 short lowercase labels'),
      notes: z.string().optional().describe('Markdown body: ## TL;DR, ## Why it matters here, …'), pdf: z.boolean().default(true).describe('Store the PDF (arXiv papers)'),
      recheck: z.boolean().default(false).describe('For a paper already in the project: search its code again even if it was settled') }, annotations: write({ openWorldHint: true }) },
    async a => { const r = await service.collectPaper(a, 'agent'); const hfOnly = r.code.attached.some((c: { foundIn: string[] }) => c.foundIn.length === 1 && ['huggingface', 'project-page'].includes(c.foundIn[0]));
      return { paper: brief(r.paper), existing: r.existing, pdf: r.pdf, code: r.code, next: r.code.result === 'found' || r.code.result === 'confirmed' ? `${r.existing ? 'Already in the project; missing parts were filled in. ' : ''}${hfOnly ? 'The code came only from Hugging Face or the project page: glance at the PDF to confirm it is the authors\' code. ' : ''}Write ## TL;DR and ## Why it matters here (research_update), then link the paper (addLinks).` : `Read the PDF at pdf.path (abstract, first-page footnotes, conclusion) for the authors' own code, then call research_set_paper_code with it, or with [] and the reason.` }; });
  tool('research_set_paper_code', { title: 'Set paper code', description: "Record a paper's own code after reading it: the authors' repositories (not baselines they use), or an empty list with the reason (e.g. \"no code release mentioned in the paper\"). Replaces the paper's code list.",
    inputSchema: { id: id.describe('Paper id'), codeUrls: z.array(z.string()).describe("The authors' repository URLs; [] for none"), reason: z.string().min(1).describe('Where in the paper you found it, or why there is none'), ...expected }, annotations: write({ openWorldHint: true, idempotentHint: true }) },
    async a => brief(await service.setPaperCode(a.id, a.codeUrls, a.reason, { expectedRevision: a.expectedRevision, expectedHash: a.expectedHash, actor: 'agent' })));
  tool('research_import_papers', { title: 'Import papers', description: "Import related work in one call: BibTeX text, the report's .bib files (fromReport), and/or paper links. arXiv entries get full metadata; others keep their BibTeX. Duplicates are skipped. Each new Paper starts To read with an empty body: then write its notes as the related-work guide asks and link it.",
    inputSchema: { projectId, fromReport: z.boolean().default(false).describe("Read every .bib file in the project's Overleaf clone"), bibtex: z.string().optional().describe('BibTeX entries to import'),
      urls: z.array(z.string()).optional().describe('arXiv or paper links'), tags: z.array(z.string()).optional().describe('Tags for every imported paper') }, annotations: write({ openWorldHint: true, idempotentHint: true }) },
    async a => { const result = await service.importPapers(a, 'agent'); return { created: result.created.map(brief), skipped: result.skipped, failed: result.failed, warnings: result.warnings, next: 'For each created paper: research_get it, write ## TL;DR and ## Why it matters here with research_update, and link it to the claim or experiment it bears on.' }; });
  tool('research_report_sync', { title: 'Sync report', description: 'Fetch the Overleaf remote and fast-forward the local clone. Never overwrites local edits (dirty or diverged stops). There is no push tool: publishing is the researcher\'s action.',
    inputSchema: { projectId }, annotations: write({ idempotentHint: true, openWorldHint: true }) }, a => { const r = reportOf(a.projectId); return syncReport(r.path, r.remote || 'origin'); });
  tool('research_attach_paper_pdf', { title: 'Attach paper PDF', description: "Store a Paper's PDF in the memory library (outside Git), from a local file or downloaded from arXiv.",
    inputSchema: { id: id.describe('Paper id'), path: z.string().optional().describe('Absolute path of a local PDF'), fromArxiv: z.boolean().optional().describe('Download from arXiv instead'), ...expected }, annotations: write({ openWorldHint: true }) },
    async a => {
      const edit = { expectedRevision: a.expectedRevision, expectedHash: a.expectedHash, actor: 'agent' as const };
      if (!a.fromArxiv && !a.path) throw new Error('Give path (a local PDF) or fromArxiv: true.');
      const paper = a.fromArxiv ? await service.fetchPaperPdf(a.id, edit) : await store.attachPaperPdf(a.id, await fs.readFile(a.path), path.basename(a.path), edit);
      return { ...brief(paper), pdfPath: store.paperPdfPath(paper) };
    });
  tool('research_prepare_run', { title: 'Prepare run', description: 'Freeze source and inputs for a run of an existing experiment brief. Does not submit. See examples/run.json for the spec.',
    inputSchema: { spec: z.record(z.any()).describe('RunSpec: requestId, projectId, experimentId, sourceRoot, command array, resources, optional units/inputs') }, annotations: write() }, a => service.prepare(a.spec));
  tool('research_submit_run', { title: 'Submit run', description: "Submit a prepared run to Slurm, only within the researcher's authorization. Repeating the same requestId never submits twice; an Unknown result needs research_refresh_runs with reconcile.",
    inputSchema: { requestId: z.string().describe('requestId from research_prepare_run') }, annotations: write({ idempotentHint: true, openWorldHint: true }) }, a => submitRun(store.root, a.requestId));
  tool('research_refresh_runs', { title: 'Refresh runs', description: 'Poll Slurm for recorded runs, or reconcile one Unknown submission. Never resubmits.',
    inputSchema: { reconcile: z.string().optional().describe('requestId of an Unknown submission to reconcile') }, annotations: write({ idempotentHint: true, openWorldHint: true }) },
    a => a.reconcile ? reconcileSubmission(store.root, a.reconcile) : refreshRuns(store.root));

  for (const [name, guide] of Object.entries(guides)) server.registerPrompt(name, { title: name, description: guide.description }, async () => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text: await readGuide(name) } }] }));
  await server.connect(new StdioServerTransport());
  process.on('SIGTERM', () => { store.close(); process.exit(0); });
}
