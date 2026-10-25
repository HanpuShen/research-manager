import type { Entity } from './types.js';
import { card, section } from './workflow.js';
import { evidenceOf, ruleMet, testsOf } from './lint.js';

// The evidence neighbourhood of one claim, with only the sections needed to judge it.
export function claimContext(all: Entity[], claimId: string, limit = 8) {
  const claim = all.find(record => record.id === claimId);
  if (!claim) throw new Error(`Record not found: ${claimId}`);
  if (claim.kind !== 'Claim') throw new Error(`Not a claim: ${claimId} is a ${claim.kind}`);
  const touches = (record: Entity, ids: Set<string>) => ids.has(record.id) || record.links.some(link => ids.has(link.target));
  const experiments = testsOf(claim, all), evidence = evidenceOf(claim, all);
  const near = new Set([claim.id, ...experiments.map(experiment => experiment.id), ...evidence.map(experiment => experiment.id)]);
  const linkedFromClaim = new Set(claim.links.map(link => link.target));
  const notes = all.filter(record => record.kind === 'Note' && (touches(record, near) || linkedFromClaim.has(record.id)));
  const observations = notes.filter(note => note.metadata.role === 'Observation').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const neighbours = all.filter(record => record.kind === 'Claim' && record.id !== claim.id && (linkedFromClaim.has(record.id) || record.links.some(link => link.target === claim.id)));
  return {
    claim: { ...card(claim), body: claim.body, metadata: claim.metadata, links: claim.links, revision: claim.revision, contentHash: claim.contentHash },
    experiments: experiments.map(experiment => ({ ...card(experiment), decisionRule: section(experiment.body, 'Decision rule') ?? null, result: section(experiment.body, 'Result'), ruleMet: ruleMet(experiment), placementSection: section(experiment.body, 'Placement') })),
    evidenceExperiments: evidence.map(experiment => ({ ...card(experiment), result: section(experiment.body, 'Result') })),
    observations: observations.slice(0, limit).map(note => ({ ...card(note), mainFinding: section(note.body, 'Main finding'), limits: section(note.body, 'Limits'), sourceCount: note.sources.length })),
    observationTotal: observations.length,
    interpretations: notes.filter(note => note.metadata.role === 'Interpretation').map(card),
    proposals: notes.filter(note => note.status === 'Proposed').map(note => ({ ...card(note), proposedStatus: note.metadata.proposedStatus, outdated: experiments.some(experiment => experiment.updatedAt > note.updatedAt) })),
    papers: all.filter(record => record.kind === 'Paper' && (touches(record, near) || linkedFromClaim.has(record.id))).map(card),
    claims: neighbours.map(card),
    next: `research_get for any full record or its sources${observations.length > limit ? `; ${observations.length - limit} older observations omitted (raise limit)` : ''}. Propose a verdict with research_propose_verdict; the researcher sets the status.`,
  };
}
