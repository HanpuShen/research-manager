import React, { useMemo } from 'react';
import type { Entity } from '../src/types.js';
import { lint } from '../src/lint.js';
import { statusTone } from './Graph.js';

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** What needs a decision: claims ready for a verdict, back-burner candidates, and guide-check issues. Read-only. */
export function ResearchHealth({ projectId, entities, onSelect }: { projectId: string; entities: Entity[]; onSelect: (id: string) => void }) {
  const result = useMemo(() => lint(entities, projectId), [entities, projectId]);
  const item = (id: string, title: string, badge: string, why?: string) => <li key={id}><button className="health-row" onClick={() => onSelect(id)}><span className="health-title">{title}</span>{why && <span className="quiet health-why">{why}</span>}<span className={`badge ${statusTone(badge)}`}>{badge}</span></button></li>;
    if (!result.readyForVerdict.length && !result.awaitingReview.length && !result.backBurnerCandidates.length && !result.issues.length) return null;
  return <section className="argument-card research-health" aria-label="Research health">
    <h3>Needs a decision <span className="quiet">· from the writing-guide checks; nothing changes until you act</span></h3>
    {!!result.awaitingReview.length && <details><summary>{plural(result.awaitingReview.length, 'verdict proposal')} awaiting you</summary><ul>{result.awaitingReview.map(a => item(a.id, a.title, `Agent proposes: ${a.proposed}`, a.outdated ? 'outdated: its experiments changed after the proposal' : 'open the claim to review it'))}</ul></details>}
    {!!result.readyForVerdict.length && <details><summary>{plural(result.readyForVerdict.length, 'claim')} ready for a verdict</summary><ul>{result.readyForVerdict.map(v => item(v.id, v.title, `Rule suggests: ${v.proposed}`, v.from.map(test => `rule met: ${test.ruleMet}`).join(', ')))}</ul></details>}
    {!!result.backBurnerCandidates.length && <details><summary>{plural(result.backBurnerCandidateTotal, 'back-burner candidate')}</summary><ul>{result.backBurnerCandidates.map(c => item(c.id, c.title, c.category, c.why))}</ul></details>}
    {!!result.issues.length && <details><summary>{plural(result.totals.issues, 'guide-check issue')}</summary>{result.issues.map(group => <details key={group.rule} className="health-group"><summary><span className={`badge ${group.severity === 'error' ? 'red' : group.severity === 'warning' ? 'amber' : 'muted'}`}>{group.count}</span> {group.message.replaceAll('`', '')}</summary><ul>{group.records.map(r => item(r.id, r.title, group.severity))}</ul>{group.count > group.records.length && <p className="quiet">{group.count - group.records.length} more: run research lint {projectId} --full.</p>}</details>)}</details>}
  </section>;
}
