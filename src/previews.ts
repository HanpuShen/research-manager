import { promises as fs } from 'node:fs';
import path from 'node:path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Entity, EntityPreview, PreviewRecord, SourcePreview, SourceRef } from './types.js';
import type { ResearchStore } from './store.js';

const MAX_FILES = 30, MAX_BYTES = 12 * 1024 * 1024;
const TEXT_BYTES = 256 * 1024, INVENTORY_BYTES = 1024 * 1024, IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_ROWS = 100, MAX_COLUMNS = 30;
const imageTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const textExtensions = new Set(['.txt', '.log', '.py', '.sh', '.tex', '.yaml', '.yml', '.toml', '.ini']);
type Budget = { files: number; bytes: number; truncated: boolean };
type Candidate = { source: SourceRef; roots: string[]; readingGuide?: string; caption?: string; group?: string; role?: SourcePreview['role']; supplementary?: boolean; inventory?: boolean; expanded?: boolean };
const local = (value: string) => !/^[a-z][a-z\d+.-]*:/i.test(value) && !value.startsWith('//') && !value.includes('\0');
const inside = (root: string, file: string) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
const isInventory = (file: string) => /(?:figure[_-]inventory|export[_-]inventory)\.json$/i.test(file);
const imageFile = (file: string) => Boolean(imageTypes[path.extname(file).toLowerCase()]);
const asCell = (value: unknown): string => value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const deduplicate = (candidates: Candidate[]) => {
  const unique = new Map<string | undefined, Candidate>();
  for (const candidate of candidates) {
    const key = candidate.source.path ?? candidate.source.url, existing = unique.get(key);
    if (existing) {
      existing.readingGuide ??= candidate.readingGuide;
      existing.caption ??= candidate.caption;
      existing.role ??= candidate.role;
      if (candidate.caption !== undefined && candidate.source.label && existing.source.label === path.basename(existing.source.path || '')) existing.source = { ...existing.source, label: candidate.source.label };
    } else unique.set(key, candidate);
  }
  return [...unique.values()];
};

async function checkedFile(file: string, roots: string[]) {
  if (!local(file)) throw new Error('Only local files declared by this record can be previewed.');
  const resolved = path.resolve(file), real = await fs.realpath(resolved);
  for (const root of roots) {
    const realRoot = await fs.realpath(root).catch(() => undefined);
    if (realRoot && inside(path.resolve(root), resolved) && inside(realRoot, real)) return real;
  }
  throw new Error('This file is outside the declared preview folder (including symlink targets).');
}

async function prefix(file: string, limit: number) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('This source is a folder. Link a result file or an artifact inventory to preview it.');
    const buffer = Buffer.alloc(Math.min(stat.size, limit));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { buffer: buffer.subarray(0, bytesRead), truncated: stat.size > limit };
  } finally { await handle.close(); }
}

function charge(budget: Budget, value: unknown) {
  const size = Buffer.byteLength(JSON.stringify(value));
  if (budget.bytes + size > MAX_BYTES) { budget.truncated = true; return false; }
  budget.bytes += size;
  return true;
}

function parseTable(text: string, separator: string, partial: boolean) {
  const records: string[][] = []; let row: string[] = [], cell = '', quoted = false, truncated = partial;
  const finishCell = () => { if (row.length < MAX_COLUMNS + 1) row.push(cell); cell = ''; };
  const finishRow = () => { finishCell(); if (row.length > MAX_COLUMNS) truncated = true; records.push(row.slice(0, MAX_COLUMNS)); row = []; };
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index++; }
      else if (quoted || !cell) quoted = !quoted;
      else cell += character;
    } else if (!quoted && character === separator) finishCell();
    else if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && text[index + 1] === '\n') index++;
      finishRow();
      if (records.length > MAX_ROWS) { if (index < text.length - 1) truncated = true; break; }
    } else if (row.length < MAX_COLUMNS + 1) cell += character;
  }
  if (records.length <= MAX_ROWS && (cell || row.length)) {
    if (!partial && !quoted) finishRow(); else truncated = true;
  }
  const width = Math.min(MAX_COLUMNS, Math.max(0, ...records.map(record => record.length)));
  const header = records.shift() ?? [];
  const columns = Array.from({ length: width }, (_, index) => header[index] || `Column ${index + 1}`);
  return { columns, rows: records.slice(0, MAX_ROWS).map(record => columns.map((_, index) => record[index] ?? '')), truncated };
}

function jsonTable(value: unknown): Pick<SourcePreview, 'columns' | 'rows' | 'truncated'> | undefined {
  if (Array.isArray(value) && value.length && value.every(item => item !== null && typeof item === 'object' && !Array.isArray(item))) {
    const keys = [...new Set(value.slice(0, MAX_ROWS + 1).flatMap(item => Object.keys(item)))];
    const columns = keys.slice(0, MAX_COLUMNS);
    return { columns, rows: value.slice(0, MAX_ROWS).map(item => columns.map(key => asCell(item[key]))), truncated: value.length > MAX_ROWS || keys.length > MAX_COLUMNS };
  }
  if (value !== null && !Array.isArray(value) && typeof value === 'object' && Object.values(value).every(item => item === null || typeof item !== 'object')) {
    const entries = Object.entries(value);
    return { columns: ['Setting', 'Value'], rows: entries.slice(0, MAX_ROWS).map(([key, item]) => [key, asCell(item)]), truncated: entries.length > MAX_ROWS };
  }
  if (Array.isArray(value) && value.every(item => item === null || typeof item !== 'object')) return { columns: ['Value'], rows: value.slice(0, MAX_ROWS).map(item => [asCell(item)]), truncated: value.length > MAX_ROWS };
  return undefined;
}

async function imageData(file: string, roots: string[], budget: Budget) {
  if (!imageFile(file)) throw new Error('Only PNG, JPEG, GIF, and WebP images are previewed.');
  if (budget.files >= MAX_FILES) { budget.truncated = true; throw new Error('Preview file limit reached. Open the source to see more.'); }
  budget.files++;
  const real = await checkedFile(file, roots);
  const { buffer, truncated } = await prefix(real, IMAGE_BYTES);
  if (truncated) throw new Error('Image exceeds the 3 MB preview limit. Open the original image.');
  const extension = path.extname(file).toLowerCase();
  const valid = extension === '.png' ? buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : extension === '.jpg' || extension === '.jpeg' ? buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
      : extension === '.gif' ? /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'))
        : buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!valid) throw new Error('The file does not contain a supported image signature.');
  const result = `data:${imageTypes[extension]};base64,${buffer.toString('base64')}`;
  if (!charge(budget, result)) throw new Error('Preview size limit reached. Open the source to see more.');
  return result;
}

async function markdownImages(text: string, base: string, roots: string[], budget: Budget) {
  const images: Record<string, string> = {}, errors: string[] = [];
  const tree = unified().use(remarkParse).parse(text.slice(0, TEXT_BYTES));
  const definitions = new Map<string, string>(); const urls = new Set<string>();
  const walk = (node: any, visit: (node: any) => void) => { visit(node); for (const child of node.children ?? []) walk(child, visit); };
  walk(tree, node => { if (node.type === 'definition') definitions.set(node.identifier, node.url); });
  walk(tree, node => {
    if (node.type === 'image') urls.add(node.url);
    if (node.type === 'imageReference' && definitions.has(node.identifier)) urls.add(definitions.get(node.identifier)!);
  });
  for (const url of [...urls].slice(0, MAX_FILES)) {
    if (!local(url)) { errors.push('Remote images are not loaded automatically.'); continue; }
    try {
      const file = path.resolve(base, decodeURIComponent(url.split(/[?#]/)[0]));
      images[url] = await imageData(file, path.isAbsolute(url) ? [...roots, path.dirname(file)] : roots, budget);
    } catch (error) { errors.push(`${url}: ${(error as Error).message}`); }
  }
  if (urls.size > MAX_FILES) { budget.truncated = true; errors.push('Additional embedded images were omitted.'); }
  return { images, message: [...new Set(errors)].join(' ') || undefined };
}

function priority(candidate: Candidate) {
  const file = candidate.source.path ?? '', name = path.basename(file).toLowerCase();
  if (candidate.supplementary) return 6;
  if (candidate.expanded) return 5;
  if (imageFile(file)) return 0;
  if (/summary|config|setting/.test(name) && /\.(csv|tsv|json)$/.test(name)) return 1;
  if (/\.(md|markdown|csv|tsv)$/.test(name)) return 2;
  if (candidate.inventory) return 5;
  return 4;
}

async function inventoryCandidates(candidate: Candidate, allowedRoots: string[]) {
  const file = candidate.source.path!;
  const real = await checkedFile(file, candidate.roots);
  const { buffer, truncated } = await prefix(real, INVENTORY_BYTES);
  if (truncated) return [];
  let inventory: any; try { inventory = JSON.parse(buffer.toString('utf8')); } catch { return []; }
  const entries: Candidate[] = [], base = path.dirname(file), roots = [...allowedRoots, base];
  const add = (target: unknown, label?: string, caption?: string, group?: string, supplementary?: boolean, role?: SourcePreview['role']) => {
    if (typeof target !== 'string' || !local(target)) return;
    const location = path.resolve(base, target);
    if (!roots.some(root => inside(root, location))) return;
    const candidate: Candidate = { source: { path: location, label }, roots, caption, group, supplementary, role };
    entries.push(candidate);
    return candidate;
  };
  if (Array.isArray(inventory)) {
    for (const entry of inventory.slice(0, 200)) {
      if (!entry || typeof entry !== 'object' || !Array.isArray(entry.artifacts)) continue;
      const artifacts = entry.artifacts.filter((item: any) => typeof item?.path === 'string');
      const composite = artifacts.find((item: any) => path.basename(item.path) === `${entry.name}.png`)
        ?? artifacts.find((item: any) => imageFile(item.path) && !/^panel[_-]/i.test(path.basename(item.path)));
      const title = typeof entry.title === 'string' ? entry.title : String(entry.name || 'Figure');
      const caption = typeof entry.caption === 'string' ? entry.caption : undefined;
      const group = `Shared figure collection · ${title}`;
      const supplementary = /^supp[_-]/.test(String(entry.name)), role = supplementary ? 'supplement' : ['setup', 'result'].includes(entry.kind) ? entry.kind as 'setup' | 'result' : undefined;
      if (composite) {
        const added = add(composite.path, title, caption, group, supplementary, role);
        if (added && typeof entry.readingGuide === 'string') added.readingGuide = entry.readingGuide.slice(0, 3000);
      }
      const table = artifacts.find((item: any) => /\.(csv|tsv)$/i.test(item.path));
      if (table) {
        const added = add(table.path, `${title} · data`, undefined, group, true, role);
        if (added && typeof entry.tableGuide === 'string') added.readingGuide = entry.tableGuide.slice(0, 3000);
      }
    }
  } else if (Array.isArray(inventory?.files)) {
    for (const item of inventory.files.slice(0, 500)) {
      const target = item?.export ?? item?.path ?? item?.relativePath;
      if (typeof target !== 'string' || !/\.(png|jpe?g|gif|webp|csv|tsv|json|md)$/i.test(target) || isInventory(target)) continue;
      const added = add(target, path.basename(target), undefined, undefined, imageFile(target));
      if (added) added.expanded = true;
    }
  }
  return entries;
}

async function candidatesFor(entity: Entity, store: ResearchStore) {
  const base = path.dirname(entity.filePath ?? path.join(store.root, 'records', `${entity.id}.md`));
  const declared = typeof entity.metadata.path === 'string' && local(entity.metadata.path) ? path.resolve(base, entity.metadata.path) : undefined;
  const declaredStat = declared ? await fs.stat(declared).catch(() => undefined) : undefined;
  const folder = declaredStat?.isDirectory() ? declared : undefined;
  const candidates: Candidate[] = entity.sources.map(source => {
    const file = source.path && local(source.path) ? path.resolve(base, source.path) : source.path;
    return { source: { ...source, path: file }, roots: file && local(file) ? [path.dirname(file), ...(folder ? [folder] : [])] : [] };
  });
  if (declared && !folder) candidates.push({ source: { path: declared, label: entity.title }, roots: [path.dirname(declared)] });
  if (folder && entity.kind === 'Artifact') {
    const directory = await fs.opendir(folder);
    let inspected = 0;
    for await (const entry of directory) {
      if (++inspected > 200) break;
      if (entry.isFile() && /\.(png|jpe?g|gif|webp|csv|tsv|json|md)$/i.test(entry.name)) candidates.push({ source: { path: path.join(folder, entry.name), label: entry.name }, roots: [folder] });
    }
  }
  const unique = deduplicate(candidates);
  for (const candidate of [...unique]) {
    if (!candidate.source.path || !isInventory(candidate.source.path)) continue;
    candidate.inventory = true;
    try { unique.push(...await inventoryCandidates(candidate, folder ? [folder] : [])); } catch { /* The linked inventory still gets its visible error preview. */ }
  }
  const sourceRoots = candidates.flatMap(candidate => candidate.source.path && imageFile(candidate.source.path) ? candidate.roots : []);
  return { base, roots: [store.root, base, ...sourceRoots, ...(folder ? [folder] : [])], candidates: deduplicate(unique) };
}

async function readSource(candidate: Candidate, budget: Budget): Promise<SourcePreview> {
  const { source, caption, readingGuide, group, role } = candidate;
  const common = { source, caption, readingGuide, group, role };
  if (!source.path || !imageFile(source.path)) {
    if (budget.files >= MAX_FILES) { budget.truncated = true; return { ...common, kind: 'unsupported', truncated: true, message: 'Preview file limit reached. Open the source to see more.' }; }
    budget.files++;
  }
  if (!source.path) return { ...common, kind: 'unsupported', message: 'Online source. Open the link to view it.' };
  try {
    if (imageFile(source.path)) return { ...common, kind: 'image', dataUrl: await imageData(source.path, candidate.roots, budget) };
    const real = await checkedFile(source.path, candidate.roots), extension = path.extname(source.path).toLowerCase();
    if (!(textExtensions.has(extension) || ['.md', '.markdown', '.csv', '.tsv', '.json'].includes(extension))) return { ...common, kind: 'unsupported', message: 'No inline preview for this file type. Open the original file.' };
    const { buffer, truncated } = await prefix(real, candidate.inventory ? INVENTORY_BYTES : TEXT_BYTES);
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
    let result: SourcePreview;
    if (candidate.inventory && !truncated) {
      const inventory = JSON.parse(text), count = Array.isArray(inventory) ? inventory.length : inventory.files?.length;
      result = { ...common, kind: 'text', text: `Inventory${typeof count === 'number' ? `: ${count} entries` : ''}. Linked figures and readable result files are shown separately. Open the inventory for all paths and provenance.`, message: 'A shared collection can include setup, results, and supplements from several experiments.' };
    } else if (extension === '.csv' || extension === '.tsv') result = { ...common, kind: 'table', ...parseTable(text, extension === '.csv' ? ',' : '\t', truncated) };
    else if (extension === '.md' || extension === '.markdown') result = { ...common, kind: 'markdown', text, truncated, ...await markdownImages(text, path.dirname(source.path), [...candidate.roots, path.dirname(source.path)], budget) };
    else if (extension === '.json' && !truncated) {
      const value = JSON.parse(text), table = jsonTable(value);
      result = table ? { ...common, kind: 'table', ...table } : { ...common, kind: 'json', text: JSON.stringify(value, null, 2) };
    } else result = { ...common, kind: extension === '.json' ? 'json' : 'text', text, truncated };
    if (result.truncated) result.message = [result.message, `Preview limited to ${MAX_ROWS} rows, ${MAX_COLUMNS} columns, or ${TEXT_BYTES / 1024} KB of text. Open the source for the complete data.`].filter(Boolean).join(' ');
    if (!charge(budget, { ...result, images: undefined })) return { ...common, kind: 'unsupported', truncated: true, message: 'Preview size limit reached. Open the source to see more.' };
    return result;
  } catch (error) {
    const message = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Source file is missing. Its link has been preserved.' : (error as Error).message;
    return { ...common, kind: 'error', message };
  }
}

export async function readEntityPreview(store: ResearchStore, entityId: string): Promise<EntityPreview> {
  const entity = store.get(entityId), all = store.list();
  const linked = entity.kind === 'Experiment' ? all.filter(record => ['Artifact', 'Note'].includes(record.kind) && record.id !== entity.id && (entity.links.some(link => link.target === record.id) || record.links.some(link => link.target === entity.id))) : [];
  const entities = [entity, ...linked], budget: Budget = { files: 0, bytes: 0, truncated: false };
  const records: PreviewRecord[] = entities.map(record => ({ entity: record, sources: [] }));
  const pending: { record: PreviewRecord; candidate: Candidate }[] = [];
  for (const record of records) {
    const previewAttachments = record.entity.kind !== 'Note' || record.entity.id === entityId || ['Observation', 'Interpretation'].includes(record.entity.metadata.role);
    const discovered = previewAttachments ? await candidatesFor(record.entity, store) : { base: path.dirname(record.entity.filePath!), roots: [store.root], candidates: [] };
    const embedded = await markdownImages(record.entity.body, discovered.base, discovered.roots, budget);
    record.images = embedded.images;
    if (embedded.message) record.sources.push({ source: { path: record.entity.filePath, label: 'Embedded images' }, kind: 'unsupported', message: embedded.message });
    pending.push(...discovered.candidates.map(candidate => ({ record, candidate })));
  }
  pending.sort((a, b) => priority(a.candidate) - priority(b.candidate));
  const shown = new Set<string>();
  for (const { record, candidate } of pending) {
    const key = candidate.source.path ?? candidate.source.url ?? '';
    if (shown.has(key)) continue;
    if (budget.files >= MAX_FILES || budget.bytes >= MAX_BYTES) { budget.truncated = true; continue; }
    shown.add(key);
    record.sources.push(await readSource(candidate, budget));
  }
  return { entityId, records, truncated: budget.truncated };
}
