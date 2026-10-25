import type { Entity } from './types.js';
import { backBurnerCategories, isBackBurner, missingFromMainline, section, statusesByKind } from './workflow.js';

// Machine checks for the self-checks in docs/*-instruction.md. Read-only: it proposes, the researcher decides.
export type Severity = 'error' | 'warning' | 'info';
export interface LintGroup { rule: string; severity: Severity; message: string; count: number; records: { id: string; title: string }[] }
export interface VerdictCandidate { id: string; title: string; proposed: 'Supported' | 'Mixed' | 'Refuted'; from: { id: string; title: string; ruleMet: string }[] }
export interface BackBurnerCandidate { id: string; title: string; kind: string; category: typeof backBurnerCategories[number]; why: string }

const SHOWN = 15, TITLE_LIMIT = 45, STALE_DAYS = 30;
const ruleMetPattern = /Rule met:\s*\**\s*(yes|partly|no)\b/i;
const verdictFor: Record<string, VerdictCandidate['proposed']> = { yes: 'Supported', partly: 'Mixed', no: 'Refuted' };
const rel = (relation: string) => relation.replaceAll('-', '_');

export function ruleMet(experiment: Entity) {
  return ruleMetPattern.exec(section(experiment.body, 'Result') ?? '')?.[1].toLowerCase();
}

/** Experiments that decide a claim (Experiment → Claim `tests`). Claim → Experiment `evidence` alone is context, not a test. */
export function testsOf(claim: Entity, records: Entity[]) {
  return records.filter(record => record.kind === 'Experiment' && record.links.some(link => link.target === claim.id && rel(link.relation) === 'tests'));
}

/** Experiments the claim cites as `evidence` without being tested by them. */
export function evidenceOf(claim: Entity, records: Entity[]) {
  const tests = new Set(testsOf(claim, records).map(experiment => experiment.id));
  const evidence = new Set(claim.links.filter(link => rel(link.relation) === 'evidence').map(link => link.target));
  return records.filter(record => record.kind === 'Experiment' && evidence.has(record.id) && !tests.has(record.id));
}

export interface ProposalAwaiting { id: string; title: string; proposed: string; noteId: string; outdated: boolean; noteIds: string[] }

export function lint(all: Entity[], projectId: string, now = new Date(), shown = SHOWN, pdfExists?: (paper: Entity) => boolean) {
  const ids = new Set(all.map(record => record.id));
  const records = all.filter(record => record.id === projectId || record.projectIds.includes(projectId));
  const project = records.find(record => record.id === projectId && record.kind === 'Project');
  if (!project && !records.length) throw new Error(`Unknown project: ${projectId}`);
  const active = records.filter(record => !isBackBurner(record));
  const byId = new Map(all.map(record => [record.id, record]));
  const groups = new Map<string, LintGroup>();
  const flag = (rule: string, severity: Severity, message: string, record: Entity) => {
    const group = groups.get(rule) ?? { rule, severity, message, count: 0, records: [] };
    group.count++;
    if (group.records.length < shown) group.records.push({ id: record.id, title: record.title });
    groups.set(rule, group);
  };

  for (const record of records) if (statusesByKind[record.kind] && !statusesByKind[record.kind].includes(record.status)) flag('unknown-status', 'warning', 'Status is not one of the allowed values for this kind (see research_guide).', record);
  for (const record of records) for (const link of record.links)
    if (!ids.has(link.target)) flag('dangling-link', 'error', 'A link points to a record that does not exist; fix or remove the link.', record);

  for (const experiment of active.filter(record => record.kind === 'Experiment')) {
    const tested = experiment.links.filter(link => rel(link.relation) === 'tests' && byId.get(link.target)?.kind === 'Claim');
    const explores = experiment.links.some(link => rel(link.relation) === 'explores');
    if (!tested.length && !explores)
      flag('experiment-unplaced', 'warning', 'Experiment tests no claim: link `tests` to the claim it decides, or `explores` to an idea for exploration.', experiment);
    if (tested.length > 1) flag('experiment-many-claims', 'info', 'Experiment tests several claims; one experiment should decide one claim.', experiment);
    if (tested.length && !section(experiment.body, 'Decision rule')) flag('experiment-no-decision-rule', 'warning', 'Experiment tests a claim but has no `## Decision rule` written before the run.', experiment);
    if (experiment.status === 'Completed' && !ruleMet(experiment)) flag('experiment-no-rule-met', 'warning', 'Completed experiment has no `## Result` starting `Rule met: yes / partly / no`.', experiment);
    if (experiment.title.length > TITLE_LIMIT) flag('title-too-long', 'info', `Claim and experiment titles fit a map card at ≤ ${TITLE_LIMIT} characters.`, experiment);
  }

  const verdicts: VerdictCandidate[] = [], awaiting: ProposalAwaiting[] = [];
  for (const claim of active.filter(record => record.kind === 'Claim')) {
    const tests = testsOf(claim, active);
    if (!tests.length && !claim.links.some(link => rel(link.relation) === 'evidence')) flag('claim-untested', 'warning', 'Claim has no experiment or evidence yet; plan one or move the claim to the back burner.', claim);
    if (claim.status !== 'Open' && /^not tested yet/i.test(String(claim.metadata.answer ?? ''))) flag('claim-stale-answer', 'warning', 'Claim has a verdict but `metadata.answer` still says Not tested yet; write the deciding result.', claim);
    if (!claim.metadata.answer) flag('claim-no-answer', 'info', 'Claim has no `metadata.answer` (one clause with the deciding number, or `Not tested yet — …`).', claim);
    if (claim.title.length > TITLE_LIMIT) flag('title-too-long', 'info', `Claim and experiment titles fit a map card at ≤ ${TITLE_LIMIT} characters.`, claim);
    const met = tests.map(experiment => ({ id: experiment.id, title: experiment.title, ruleMet: ruleMet(experiment) }));
    const latest = tests.reduce((time, experiment) => experiment.updatedAt > time ? experiment.updatedAt : time, '');
    const open = records.filter(note => note.kind === 'Note' && note.status === 'Proposed' && note.links.some(link => link.target === claim.id && rel(link.relation) === 'proposes')).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const proposal = open[0];
    const outdated = !!proposal && proposal.updatedAt < latest;
    if (proposal && claim.status === 'Open') awaiting.push({ id: claim.id, title: claim.title, proposed: String(proposal.metadata.proposedStatus ?? 'unknown'), noteId: proposal.id, outdated, noteIds: open.map(note => note.id) });
    if (claim.status === 'Open' && (!proposal || outdated) && met.length && met.every(test => test.ruleMet) && tests.every(experiment => experiment.status === 'Completed' && section(experiment.body, 'Decision rule'))) {
      const answers = new Set(met.map(test => test.ruleMet!));
      verdicts.push({ id: claim.id, title: claim.title, proposed: answers.size === 1 ? verdictFor[[...answers][0]] : 'Mixed', from: met as VerdictCandidate['from'] });
    }
  }

  for (const paper of records.filter(record => record.kind === 'Paper')) {
    if (!section(paper.body, 'Why it matters here')) flag('paper-no-relevance', 'info', 'Paper has no `## Why it matters here` section (see research_guide related-work).', paper);
    if (paper.metadata.pdfUrl && (!paper.metadata.pdf || (pdfExists && !pdfExists(paper)))) flag('paper-no-pdf', 'info', 'arXiv paper without a stored PDF file (research_add_paper on it again, or research_attach_paper_pdf with fromArxiv).', paper);
    if (!paper.metadata.codeSearch || paper.metadata.codeSearch.result === 'unconfirmed') flag('paper-code-unchecked', 'info', 'Paper code not checked yet: read the PDF and call research_set_paper_code (repositories, or [] with a reason).', paper);
    if (!paper.links.length && !records.some(other => other.links.some(link => link.target === paper.id))) flag('paper-unlinked', 'info', 'Paper is not linked to any claim, experiment, or idea.', paper);
  }
  for (const note of active.filter(record => record.kind === 'Note' && record.metadata.role === 'Observation'))
    if (!section(note.body, 'Main finding')) flag('observation-no-main-finding', 'info', 'Observation has no `## Main finding` paragraph, so cards and reviews have no summary.', note);

  for (const claim of project ? missingFromMainline(project, records) : []) flag('mainline-missing-claim', 'warning', 'The primary handoff discusses this claim, but it is not in the Overview mainline (`researchFlow.overviewNodeIds`).', claim);

  const candidates: BackBurnerCandidate[] = [];
  const deciding = new Set([...verdicts, ...awaiting].map(claim => claim.id));
  const propose = (record: Entity, category: BackBurnerCandidate['category'], why: string) => {
    if (!deciding.has(record.id) && !candidates.some(candidate => candidate.id === record.id)) candidates.push({ id: record.id, title: record.title, kind: record.kind, category, why });
  };
  const flow = project?.metadata.researchFlow?.version === 1 && Array.isArray(project.metadata.researchFlow.nodeIds) ? new Set<string>(project.metadata.researchFlow.nodeIds) : undefined;
  const nearFlow = (record: Entity) => !flow || flow.has(record.id) || record.links.some(link => flow.has(link.target)) || records.some(other => flow.has(other.id) && other.links.some(link => link.target === record.id));
  const shelvable = active.filter(record => record.kind === 'Idea' || record.kind === 'Experiment' || record.kind === 'Claim');
  for (const record of shelvable) {
    if (record.metadata.mergedInto || record.metadata.merged_into) propose(record, 'merged', 'Merged into another record.');
    if (record.kind === 'Claim' && record.status === 'Refuted') propose(record, 'refuted', 'The researcher refuted this claim; keep the evidence, take it off the mainline.');
    if (record.kind === 'Experiment') {
      const tested = record.links.filter(link => rel(link.relation) === 'tests').map(link => byId.get(link.target)).filter((claim): claim is Entity => !!claim);
      if (tested.length && tested.every(isBackBurner)) propose(record, 'superseded', 'Every claim it tests is on the back burner.');
    }
    if (record.kind === 'Idea' && record.status === 'Inbox' && now.getTime() - Date.parse(record.updatedAt) > STALE_DAYS * 86400e3) propose(record, 'deprioritized', `Inbox idea untouched for more than ${STALE_DAYS} days.`);
    if (record.kind !== 'Idea' && !nearFlow(record) && record.status !== 'Running' && record.status !== 'Planned') propose(record, 'out-of-scope', 'Not on the authored research flow and not linked to anything on it.');
  }

  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return {
    projectId, generatedAt: now.toISOString(),
    totals: { records: records.length, active: active.length, backBurner: records.length - active.length, issues: [...groups.values()].reduce((sum, group) => sum + group.count, 0) },
    issues: [...groups.values()].map(group => ({ ...group, truncated: group.count > group.records.length })).sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count),
    readyForVerdict: verdicts, awaitingReview: awaiting,
    backBurnerCandidates: candidates.slice(0, 40), backBurnerCandidateTotal: candidates.length,
    next: 'Fix errors first. Propose verdicts with research_propose_verdict (CLI: propose). Move candidates only after the researcher agrees, with research_set_back_burner and a category (CLI: park ID REASON --category C).',
  };
}
