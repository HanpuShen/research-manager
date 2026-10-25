import React from 'react';
import type { Entity } from '../src/types.js';
import { reviewSections } from './Review.js';
import { InlineMath, MarkdownText } from './Markdown.js';
import { statusTone } from './Graph.js';
import type { Send } from './EntityDetails.js';
import { isBackBurner } from '../src/workflow.js';

export interface ProjectArgument { question: string; hard?: string; idea?: string; answer?: string; next?: string }

/** The argument sections of a Project body; undefined unless it has a `## Question` section. */
export function argumentOf(project?: Entity): ProjectArgument | undefined {
  if (!project) return undefined;
  const sections = reviewSections(project.body);
  const get = (pattern: RegExp) => sections.find(section => pattern.test(section.title))?.body;
  const question = get(/^question\b/i);
  if (!question) return undefined;
  return { question, hard: get(/^(why (it is|it's) hard|obstacle|challenge)\b/i), idea: get(/^key idea\b/i), answer: get(/^(current answer|answer so far|answer)\b/i), next: get(/^(next decision|open problems|next)\b/i) };
}

/** First paragraph of a Project body that is not a heading (the page subtitle). */
export function projectSummary(project?: Entity) {
  return project?.body.split(/\n\s*\n/).map(part => part.trim()).find(part => part && !part.startsWith('#')) || '';
}

export function stageClaims(project: Entity, entities: Entity[]) {
  const ids: string[] = project.metadata.researchFlow?.overviewNodeIds || [];
  const byId = new Map(entities.map(entity => [entity.id, entity]));
  const ordered = ids.map(id => byId.get(id)).filter((entity): entity is Entity => entity?.kind === 'Claim' && !isBackBurner(entity));
  return ordered.length ? ordered : entities.filter(entity => entity.kind === 'Claim' && !isBackBurner(entity) && entity.projectIds.includes(project.id)).sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
}

export function OverviewArgument({ project, argument, entities, send, onSelect, onOpenMap }: { project: Entity; argument: ProjectArgument; entities: Entity[]; send: Send; onSelect: (id: string) => void; onOpenMap: () => void }) {
  const claims = stageClaims(project, entities);
  const edges: { source: string; target: string; label?: string }[] = project.metadata.researchFlow?.edges || [];
  const text = (value?: string) => value ? <MarkdownText text={value} documentPath={project.filePath} send={send} /> : null;
  return <section className="argument-page" aria-label="Project argument">
    <div className="argument-question"><span className="eyebrow">Question</span>{text(argument.question)}</div>
    {argument.answer && <div className="argument-card argument-answer"><h3>Current answer</h3>{text(argument.answer)}</div>}
    {(argument.hard || argument.idea) && <div className="argument-pair">
      {argument.hard && <div className="argument-card"><h3>Why it is hard</h3>{text(argument.hard)}</div>}
      {argument.idea && <div className="argument-card"><h3>Key idea</h3>{text(argument.idea)}</div>}
    </div>}
    <div className="argument-chain"><h3>Argument <span className="quiet">{claims.length} claims · click one for its evidence</span></h3>
      <ol>{claims.map((claim, index) => {
        const match = claim.title.match(/^(\d+)[.)]\s*(.*)$/);
        const step = edges.find(edge => edge.source === claim.id && edge.target === claims[index + 1]?.id)?.label;
        const reported = claim.metadata.reportedVerdict;
        return <li key={claim.id}>
          <button className="argument-claim" onClick={() => onSelect(claim.id)}>
            <span className="argument-number">{match?.[1] || '–'}</span>
            <span className="argument-copy"><strong><InlineMath text={match?.[2] || claim.title} /></strong>{claim.metadata.answer && <span><InlineMath text={String(claim.metadata.answer)} /></span>}</span>
            <span className="argument-badges">{reported && <span className={`badge ${statusTone(String(reported))}`} title="Reported by the source; not your judgment">Reported: {String(reported)}</span>}<span className={`badge ${statusTone(claim.metadata.needsReview ? 'Needs review' : claim.status)}`} title="Your judgment">{claim.metadata.needsReview ? 'Needs review' : claim.status}</span></span>
          </button>
          {step && <span className="argument-step">↓ {step}</span>}
        </li>;
      })}</ol>
    </div>
    {argument.next && <div className="argument-card"><h3>Next decision</h3>{text(argument.next)}</div>}
    <button className="text-button argument-map-link" onClick={onOpenMap}>Open the experiment map →</button>
  </section>;
}
