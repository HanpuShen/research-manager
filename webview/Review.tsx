import React from 'react';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Entity, PreviewRecord } from '../src/types.js';
import type { Send } from './EntityDetails.js';
import { InlineMath, MarkdownText } from './Markdown.js';

type Section = { title: string; body: string };
export function reviewSections(body: string): Section[] {
  const nodes = unified().use(remarkParse).use(remarkGfm).parse(body).children;
  const sections: Section[] = [];
  let title = '', start = 0;
  for (const node of nodes) {
    if (node.type !== 'heading' || node.depth > 2) continue;
    sections.push({ title, body: body.slice(start, node.position!.start.offset).trim() });
    title = body.slice(node.position!.start.offset, node.position!.end.offset).replace(/^#+\s*/, '');
    start = node.position!.end.offset!;
  }
  sections.push({ title, body: body.slice(start).trim() });
  return sections.filter(section => section.body);
}
const measured = /^(paired observations|measured outcomes|measured results|main finding|key findings|results|observations)\b/i;
export function observationOrder(records: PreviewRecord[]): PreviewRecord[] {
  const score = (record: PreviewRecord) => reviewSections(record.entity.body).reduce((best, section) => Math.max(best, measured.test(section.title) ? 2 + (/\|.+\|/.test(section.body) ? 1 : 0) : 0), 0);
  return [...records].sort((a, b) => score(b) - score(a));
}
export function reviewEvidence(body: string) {
  const candidates = reviewSections(body).filter(item => measured.test(item.title));
  const section = candidates.find(item => unified().use(remarkParse).use(remarkGfm).parse(item.body).children.some(node => node.type === 'table')) || candidates[0];
  if (!section) return;
  const nodes = unified().use(remarkParse).use(remarkGfm).parse(section.body).children;
  const table = nodes.find(node => node.type === 'table');
  if (!table) return { title: section.title, guide: '', table: '', rest: section.body };
  return { title: section.title, guide: section.body.slice(0, table.position!.start.offset).trim(), table: section.body.slice(table.position!.start.offset, table.position!.end.offset), rest: section.body.slice(table.position!.end.offset).trim() };
}
function firstParagraph(text = '') { return text.split(/\n\s*\n/)[0] || ''; }

export function Review({ entity, records, entities, send, onSelect, openResults }: { entity: Entity; records: PreviewRecord[]; entities: Entity[]; send: Send; onSelect: (id: string) => void; openResults: () => void }) {
  const sections = reviewSections(entity.body);
  const question = sections.find(item => /^(question|research question|objective)\b/i.test(item.title));
  const observations = observationOrder(records.filter(record => record.entity.metadata.role === 'Observation' && record.entity.status !== 'Invalid'));
  const observation = observations.find(record => reviewEvidence(record.entity.body));
  const evidence = observation && reviewEvidence(observation.entity.body);
  const finding = observation && reviewSections(observation.entity.body).find(item => /^(main finding|key findings|takeaway)\b/i.test(item.title));
  const limitRecord = observation && reviewSections(observation.entity.body).find(item => /^(limits|limitations|scope|counterconditions)\b/i.test(item.title));
  const limit = limitRecord || sections.find(item => /^(interpretation limits|limits|limitations|state and scope)\b/i.test(item.title));
  const linkedClaims = entities.filter(other => other.kind === 'Claim' && (entity.links.some(link => link.target === other.id) || other.links.some(link => link.target === entity.id)));
  const tested = linkedClaims.filter(claim => entity.links.some(link => link.target === claim.id && /^(tests|supports|refutes)$/.test(link.relation)));
  const claims = tested.length ? tested : linkedClaims;
  const verdict = sections.find(item => /^result\b/i.test(item.title))?.body.split('\n')[0].match(/^rule met:\s*(yes|partly|no)\b(.*)$/i);
  const why = sections.find(item => /^(why this comparison|why this experiment|motivation)\b/i.test(item.title));
  const rule = sections.find(item => /^(decision rule|decision criteria|judgment criteria|success criteria)\b/i.test(item.title));
  const invalid = records.filter(record => record.entity.status === 'Invalid' || record.entity.metadata.needsReview);
  const text = (value: string, source = entity) => <MarkdownText text={value} documentPath={source.filePath} send={send} />;
  const sourceLink = (source: Entity) => <button className="text-button review-source" onClick={() => onSelect(source.id)}>Source: {source.title} →</button>;
  return <section className="quick-review" role="tabpanel" id="panel-review" aria-labelledby="tab-review">
    <div className="review-claims"><span className="quiet">{tested.length ? 'Tests' : 'Claim'}</span>{claims.length ? claims.map(claim => <button className="text-button review-claim-link" key={claim.id} onClick={() => onSelect(claim.id)} title="Open the claim"><strong>{claim.title}</strong> <span className="quiet">· {claim.status}{claim.metadata.needsReview ? ' · Needs review' : ''}</span></button>) : <span>No linked claim</span>}</div>
    {verdict && <p className={`review-verdict ${verdict[1].toLowerCase()}`}><strong>Rule met: {verdict[1].toLowerCase()}</strong>{rule && /reconstructed/i.test(rule.title) && <span className="badge amber review-reconstructed" title="This decision rule was written after the results were known">Rule reconstructed after the run</span>}<InlineMath text={verdict[2].replace(/^\s*[—-]\s*/, ' — ')} /></p>}
    {invalid.length > 0 && <p className="notice">Linked evidence needs review or is invalid. Check the full results before relying on this excerpt.</p>}
    <section className="review-block"><h3>Question</h3>{question ? text(firstParagraph(question.body)) : <p className="quiet">No question section recorded. Read Setup for the full brief.</p>}</section>
    {why && <section className="review-block"><h3>Why this comparison</h3>{text(firstParagraph(why.body))}</section>}
    {rule && <section className="review-block"><h3>{/reconstructed/i.test(rule.title) ? 'Decision rule (reconstructed after the run)' : 'Decision rule'}</h3>{text(firstParagraph(rule.body))}</section>}
    {finding && observation && <section className="review-block"><h3>Recorded finding</h3>{text(firstParagraph(finding.body), observation.entity)}{sourceLink(observation.entity)}</section>}
    <section className="review-block"><h3>Start with the evidence</h3>
      {evidence && observation ? <><p className="review-evidence-title">{observation.entity.title}</p>
        {evidence.guide && <div className="reading-guide"><strong>How to read</strong>{text(evidence.guide, observation.entity)}</div>}
        {evidence.table ? <>{text(evidence.table, observation.entity)}{/\|\s*[+−-]\d/.test(evidence.table) && <p className="quiet">For differences, check the subtraction order; + and − do not by themselves mean better or worse.</p>}</> : text(firstParagraph(evidence.rest), observation.entity)}
        {sourceLink(observation.entity)}
        {evidence.table && evidence.rest && <details className="preview-more"><summary>Read the observations and counterexamples</summary>{text(evidence.rest, observation.entity)}</details>}
        {!finding && <p className="quiet review-missing">No short finding recorded. This is a source excerpt, not an automatic verdict.</p>}
      </> : <p className="quiet">No measured result section recorded. Open Results for linked notes and files; completion alone is not evidence.</p>}
    </section>
    {limit && <section className="review-block review-limit"><h3>What this can tell us</h3>{text(firstParagraph(limit.body), limitRecord ? observation!.entity : entity)}</section>}
    <button className="review-open-results" onClick={openResults}>Explore figures and full results →</button>
    <p className="quiet">Selected excerpts from linked records. Other observations and interpretations remain in Results.</p>
  </section>;
}
