import type { Entity } from './types.js';

export const backBurnerCategories = ['deprioritized', 'superseded', 'refuted', 'out-of-scope', 'merged'] as const;

export interface BackBurner {
  active: boolean;
  reason: string;
  category?: typeof backBurnerCategories[number];
  supersededBy?: string;
  at: string;
  by: 'agent' | 'human';
  previousStatus?: string;
  restoredAt?: string;
  restoredBy?: 'agent' | 'human';
}

export function canBackBurner(entity: Pick<Entity, 'kind'>) {
  return entity.kind === 'Idea' || entity.kind === 'Experiment' || entity.kind === 'Claim';
}

export function isBackBurner(entity: Pick<Entity, 'kind' | 'status' | 'metadata'>) {
  if (!canBackBurner(entity)) return false;
  const placement = entity.metadata.backBurner;
  return placement?.active === true || (entity.status === 'Parked' && placement?.active !== false);
}

export function validateBackBurner(entity: Pick<Entity, 'kind' | 'metadata'>) {
  if (!Object.hasOwn(entity.metadata, 'backBurner')) return;
  const placement = entity.metadata.backBurner;
  const actor = (value: unknown) => value === 'agent' || value === 'human';
  const date = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
  if (!canBackBurner(entity) || !placement || typeof placement !== 'object' || Array.isArray(placement)
    || typeof placement.active !== 'boolean' || typeof placement.reason !== 'string'
    || !date(placement.at) || !actor(placement.by)
    || (placement.previousStatus !== undefined && (typeof placement.previousStatus !== 'string' || !placement.previousStatus.trim()))
    || (placement.restoredAt !== undefined && !date(placement.restoredAt))
    || (placement.restoredBy !== undefined && !actor(placement.restoredBy))
    || (placement.category !== undefined && !backBurnerCategories.includes(placement.category))
    || (placement.supersededBy !== undefined && (typeof placement.supersededBy !== 'string' || !placement.supersededBy.trim()))) {
    throw new Error(`Invalid backBurner metadata: only ideas, experiments, and claims accept a placement with active, reason, at, and by; category is one of ${backBurnerCategories.join(', ')}.`);
  }
}

const summarySections = ['Main finding', 'Summary', 'TL;DR', 'Statement', 'Question'];

/** Body of the first `## <name>…` section (heading prefix match, e.g. "Decision rule (reconstructed…)"), trimmed. */
export function section(body: string, name: string) {
  return new RegExp(`^##\\s+${name.replace(/[.*+?^${}()|[\]\\;]/g, '\\$&')}\\b[^\\n]*$([\\s\\S]*?)(?=^#{1,2}\\s|(?![\\s\\S]))`, 'mi').exec(body)?.[1].trim() || undefined;
}

// First paragraph of the most informative authored section; never a generated summary.
export function summarize(body: string, limit = 240) {
  const text = firstParagraph(summarySections.map(name => section(body, name)).find(Boolean) ?? body);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** First prose paragraph: heading lines dropped; tables, code fences, and images skipped. */
export function firstParagraph(text: string) {
  return text.split(/\n\s*\n/).map(p => p.split('\n').filter(line => !/^#{1,6}\s/.test(line)).join('\n').trim())
    .find(p => p && !/^(\||```|~~~|!\[)/.test(p))?.replace(/\s+/g, ' ') ?? '';
}

export function outline(body: string) {
  return body.split(/^(?=## )/m).filter(part => part.startsWith('## ')).map(part => ({ heading: part.slice(3, part.indexOf('\n') < 0 ? undefined : part.indexOf('\n')).trim(), summary: summarize(part.slice(part.indexOf('\n') + 1), Infinity) }));
}

export function card(entity: Entity) {
  return { id: entity.id, kind: entity.kind, title: entity.title, status: entity.status, placement: isBackBurner(entity) ? 'Back burner' : 'Active', ...(entity.metadata.role ? { role: entity.metadata.role } : {}), updatedAt: entity.updatedAt, summary: entity.kind === 'Project' ? summarize(entity.body.split(/^## /m)[0]) || summarize(entity.body) : summarize(entity.body) };
}

export function primaryHandoff(project: Entity | undefined, related: Entity[]) {
  const handoffs = related.filter(entity => entity.kind === 'Note' && entity.metadata.role === 'Handoff');
  return handoffs.find(entity => entity.id === project?.metadata.researchFlow?.handoffId) || handoffs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

/** Claims the primary handoff discusses that are missing from the Overview mainline (`overviewNodeIds`). */
export function missingFromMainline(project: Entity, records: Entity[]) {
  const mainline = project.metadata.researchFlow?.overviewNodeIds;
  const handoff = primaryHandoff(project, records);
  if (!Array.isArray(mainline) || !handoff) return [];
  const byId = new Map(records.map(record => [record.id, record]));
  return [...new Set(handoff.links.map(link => link.target))].map(id => byId.get(id)).filter((claim): claim is Entity => claim?.kind === 'Claim' && !isBackBurner(claim) && !mainline.includes(claim.id));
}

/** Statuses each kind may be written with. Claims are human-reviewed; `Reviewed` notes and `Invalid` artifacts come from their own commands. */
export const statusesByKind: Record<string, string[]> = {
  Project: ['Active', 'Archived'],
  Idea: ['Inbox', 'Open', 'Active', 'Merged', 'Parked'],
  Claim: ['Open', 'Supported', 'Mixed', 'Refuted'],
  Experiment: ['Planned', 'Running', 'Completed', 'Failed', 'Active', 'Parked'],
  Artifact: ['Active', 'Available', 'Unavailable', 'Inbox', 'Ready', 'Needs review', 'Invalid'],
  Note: ['Active', 'Inbox', 'Archived', 'Completed', 'Proposed', 'Reviewed'],
  Paper: ['To read', 'Reading', 'Read'],
};
