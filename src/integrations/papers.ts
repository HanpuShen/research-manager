import { inflateSync, constants as zlibConstants } from 'node:zlib';
// Related-work metadata: link parsing plus arXiv and GitHub lookups. Only the link itself is sent to those
// services; nothing from the research memory leaves the machine.
export type Fetcher = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;

export interface PaperLink { kind: 'arxiv' | 'web'; url: string; arxivId?: string }
export interface CodeLink { url: string; name?: string; description?: string; stars?: number; updatedAt?: string; fetchedAt?: string }
export interface PaperMetadata {
  title: string; authors: string[]; year?: number; venue?: string; abstract?: string;
  paperUrl: string; arxivId?: string; pdfUrl?: string; bibtex?: string; fetchedFrom?: 'arxiv'; fetchedAt?: string; comment?: string;
}

const ARXIV_NEW = /^(\d{4}\.\d{4,5})(v\d+)?$/;
const ARXIV_OLD = /^([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?$/;

/** Normalizes an arXiv identifier from an abs/pdf/html URL or a bare ID (version suffix dropped). */
export function arxivIdFrom(input: string): string | undefined {
  const text = input.trim();
  const bare = text.replace(/^arxiv:/i, '');
  for (const re of [ARXIV_NEW, ARXIV_OLD]) { const m = re.exec(bare); if (m) return m[1]; }
  let url: URL;
  try { url = new URL(text); } catch { return undefined; }
  if (!/(^|\.)arxiv\.org$/i.test(url.hostname)) return undefined;
  const m = /^\/(?:abs|pdf|html)\/(.+?)(?:\.pdf)?\/?$/.exec(url.pathname);
  if (!m) return undefined;
  for (const re of [ARXIV_NEW, ARXIV_OLD]) { const id = re.exec(m[1]); if (id) return id[1]; }
  return undefined;
}

export function parsePaperLink(input: string): PaperLink {
  const arxivId = arxivIdFrom(input);
  if (arxivId) return { kind: 'arxiv', url: `https://arxiv.org/abs/${arxivId}`, arxivId };
  const url = webUrl(input);
  return { kind: 'web', url };
}

export function webUrl(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error('Enter a full web link (https://…) or an arXiv ID.'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Only web links are supported.');
  return url.toString();
}

/** owner/repo of a GitHub repository link, or undefined for other hosts. */
export function githubRepo(input: string): { owner: string; repo: string; url: string } | undefined {
  let url: URL;
  try { url = new URL(input.trim()); } catch { return undefined; }
  if (!/^(www\.)?github\.com$/i.test(url.hostname)) return undefined;
  const [owner, repo] = url.pathname.split('/').filter(Boolean);
  if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return undefined;
  const name = repo.replace(/\.git$/, '');
  return { owner, repo: name, url: `https://github.com/${owner}/${name}` };
}

/** Comparable key so the same paper is not added twice to one project. */
export function paperKey(metadata: { arxivId?: string; paperUrl?: string }): string | undefined {
  if (metadata.arxivId) return `arxiv:${metadata.arxivId.toLowerCase()}`;
  if (!metadata.paperUrl) return undefined;
  try {
    const url = new URL(metadata.paperUrl);
    return `url:${url.hostname.replace(/^www\./, '').toLowerCase()}${url.pathname.replace(/\/+$/, '')}${url.search}`;
  } catch { return undefined; }
}

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (text: string) => text
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&(amp|lt|gt|quot|apos);/g, (_, n) => entities[n]);
const squash = (text: string) => decode(text).replace(/\s+/g, ' ').trim();
const tag = (xml: string, name: string) => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml); return m ? squash(m[1]) : undefined; };

/** Parses the Atom response of export.arxiv.org/api/query for one ID. */
export function parseArxivAtom(xml: string, arxivId: string): PaperMetadata {
  const entry = /<entry>([\s\S]*?)<\/entry>/.exec(xml)?.[1];
  const title = entry && tag(entry, 'title');
  if (!entry || !title || /^Error$/i.test(title)) throw new Error(`arXiv has no record for ${arxivId}.`);
  const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)].map(m => squash(m[1]));
  const published = tag(entry, 'published');
  const year = published ? Number(published.slice(0, 4)) : undefined;
  const journal = tag(entry, 'arxiv:journal_ref');
  const category = /<arxiv:primary_category[^>]*term="([^"]+)"/.exec(entry)?.[1];
  const metadata: PaperMetadata = {
    title, authors, year: Number.isFinite(year) ? year : undefined, venue: journal || 'arXiv', abstract: tag(entry, 'summary'),
    paperUrl: `https://arxiv.org/abs/${arxivId}`, arxivId, pdfUrl: `https://arxiv.org/pdf/${arxivId}`, fetchedFrom: 'arxiv',
  };
  const comment = tag(entry, 'arxiv:comment');
  if (comment) metadata.comment = comment;
  metadata.bibtex = arxivBibtex(metadata, category);
  return metadata;
}

export function arxivBibtex(m: PaperMetadata, category?: string) {
  const first = (m.authors[0] || 'anon').split(/\s+/).at(-1)!.normalize('NFD').replace(/[^A-Za-z]/g, '').toLowerCase() || 'anon';
  const word = m.title.split(/\s+/).map(w => w.replace(/[^A-Za-z]/g, '').toLowerCase()).find(w => w.length > 3) || 'paper';
  const esc = (s: string) => s.replace(/[{}]/g, '');
  return [
    `@misc{${first}${m.year ?? ''}${word},`,
    `  title = {${esc(m.title)}},`,
    `  author = {${m.authors.map(esc).join(' and ')}},`,
    ...(m.year ? [`  year = {${m.year}},`] : []),
    ...(m.arxivId ? [`  eprint = {${m.arxivId}},`, '  archivePrefix = {arXiv},'] : []),
    ...(category ? [`  primaryClass = {${category}},`] : []),
    `  url = {${m.paperUrl}},`,
    '}',
  ].join('\n');
}

async function get(fetcher: Fetcher, url: string, timeoutMs: number, headers?: Record<string, string>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { signal: controller.signal, headers });
    if (!response.ok) throw new Error(`${new URL(url).hostname} returned ${response.status}.`);
    return response;
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw new Error(`${new URL(url).hostname} did not respond within ${timeoutMs / 1000} s.`);
    throw error;
  } finally { clearTimeout(timer); }
}

export async function fetchArxiv(arxivId: string, fetcher: Fetcher = globalThis.fetch as unknown as Fetcher, timeoutMs = 15000) {
  const response = await get(fetcher, `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`, timeoutMs);
  return { ...parseArxivAtom(await response.text(), arxivId), fetchedAt: new Date().toISOString() };
}

export async function fetchGithub(input: string, fetcher: Fetcher = globalThis.fetch as unknown as Fetcher, timeoutMs = 15000): Promise<CodeLink> {
  const repo = githubRepo(input);
  if (!repo) return { url: webUrl(input) };
  const response = await get(fetcher, `https://api.github.com/repos/${repo.owner}/${repo.repo}`, timeoutMs, { Accept: 'application/vnd.github+json', 'User-Agent': 'research-manager' });
  const data = JSON.parse(await response.text());
  return { url: data.html_url || repo.url, name: data.full_name || `${repo.owner}/${repo.repo}`, description: data.description || undefined,
    stars: typeof data.stargazers_count === 'number' ? data.stargazers_count : undefined, updatedAt: data.pushed_at || undefined, fetchedAt: new Date().toISOString() };
}

export async function downloadPdf(url: string, fetcher: Fetcher = globalThis.fetch as unknown as Fetcher, timeoutMs = 60000) {
  const response = await get(fetcher, url, timeoutMs);
  return Buffer.from(await response.arrayBuffer());
}

export interface BibEntry { type: string; key: string; fields: Record<string, string>; raw: string; unbalanced?: boolean }

/** Minimal BibTeX reader: @type{key, field = {…} | "…" | bare, …}. Braces nest; LaTeX is left as written. */
export function parseBibtex(text: string): BibEntry[] {
  const entries: BibEntry[] = [];
  for (let at = text.indexOf('@'); at >= 0; at = text.indexOf('@', at + 1)) {
    const head = /^@(\w+)\s*\{\s*([^,\s]+)\s*,/.exec(text.slice(at));
    if (!head || /^(comment|string|preamble)$/i.test(head[1])) continue;
    // An entry never extends past the next line that starts with @, so one unclosed brace cannot swallow the entries after it.
    const next = text.slice(at + 1).search(/\n\s*@\w+\s*\{/), limit = next < 0 ? text.length : at + 1 + next;
    let depth = 0, end = -1;
    for (let i = text.indexOf('{', at); i < limit; i++) { if (text[i] === '{') depth++; else if (text[i] === '}' && --depth === 0) { end = i; break; } }
    const unbalanced = end < 0;
    if (unbalanced) end = limit - 1;
    const body = text.slice(at + head[0].length, end), fields: Record<string, string> = {};
    for (let i = 0; i < body.length;) {
      const name = /^\s*,?\s*([A-Za-z][\w-]*)\s*=\s*/.exec(body.slice(i));
      if (!name) break;
      i += name[0].length;
      let value = '';
      if (body[i] === '{') { let d = 0, j = i; for (; j < body.length; j++) { if (body[j] === '{') d++; else if (body[j] === '}' && --d === 0) break; } value = body.slice(i + 1, j); i = j + 1; }
      else if (body[i] === '"') { const j = body.indexOf('"', i + 1); value = body.slice(i + 1, j); i = j + 1; }
      else { const m = /^[^,}]*/.exec(body.slice(i))!; value = m[0].trim(); i += m[0].length; }
      fields[name[1].toLowerCase()] = value.replace(/\s+/g, ' ').trim();
    }
    entries.push({ type: head[1].toLowerCase(), key: head[2], fields, raw: text.slice(at, end + 1).trimEnd(), ...(unbalanced ? { unbalanced } : {}) });
    at = end;
  }
  return entries;
}

/** What addPaper needs from one bib entry; braces are stripped from the title only. */
export function paperFromBib(entry: BibEntry) {
  const f = entry.fields;
  // arXiv ids hide in eprint, url, or Google Scholar's journal/note ("arXiv preprint arXiv:2411.04983").
  const arxivId = (/arxiv/i.test(f.archiveprefix ?? '') || /^\d{4}\.\d{4,5}/.test(f.eprint ?? '')) && f.eprint ? f.eprint
    : [f.url, f.journal, f.note, f.howpublished].map(value => value && (arxivIdFrom(value) ?? /arxiv[:\s/]*(\d{4}\.\d{4,5})/i.exec(value)?.[1])).find(Boolean);
  const arxiv = arxivId ? `https://arxiv.org/abs/${arxivId}` : undefined;
  const url = arxiv ?? f.url ?? (f.doi ? `https://doi.org/${f.doi}` : undefined);
  return {
    url, title: (f.title ?? '').replace(/[{}]/g, ''), bibtexKey: entry.key, bibtex: entry.raw,
    authors: f.author ? f.author.split(/\s+and\s+/).map(name => name.includes(',') ? name.split(',').reverse().join(' ').trim() : name.trim()) : undefined,
    year: f.year && /^\d{4}$/.test(f.year) ? Number(f.year) : undefined, venue: f.booktitle ?? (arxivId && /arxiv/i.test(f.journal ?? '') ? undefined : f.journal), unbalanced: entry.unbalanced,
  };
}

/** Title comparison key: case, braces, punctuation and spacing ignored. */
export const titleKey = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** arXiv papers whose title matches, best first (only titles and ids are sent to arXiv). */
export async function searchArxiv(title: string, fetcher: Fetcher = globalThis.fetch as unknown as Fetcher, timeoutMs = 15000, mode: 'phrase' | 'words' = 'phrase') {
  const words = title.replace(/[^\p{L}\p{N}\s-]/gu, ' ').trim();
  const query = mode === 'phrase' ? `ti:"${words}"` : words.split(/[\s-]+/).filter(w => w.length > 2).slice(0, 10).map(w => `ti:${w}`).join(' OR ');
  const response = await get(fetcher, `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&max_results=5${mode === 'words' ? '&sortBy=relevance' : ''}`, timeoutMs);
  return [...(await response.text()).matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => ({ arxivId: arxivIdFrom(tag(m[1], 'id') ?? '') ?? '', title: tag(m[1], 'title') ?? '' })).filter(hit => hit.arxivId && hit.title);
}

const notRepos = new Set(['features', 'about', 'topics', 'orgs', 'sponsors', 'marketplace', 'login', 'settings', 'site', 'collections', 'explore']);
/** owner/repo GitHub links in free text, normalised to https://github.com/owner/repo. */
export function githubRepos(text: string) {
  const repos = new Set<string>();
  for (const m of text.matchAll(/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]+)/g)) {
    const repo = m[2].replace(/\.git$/, '').replace(/[.]+$/, '');
    if (!notRepos.has(m[1].toLowerCase()) && repo) repos.add(`https://github.com/${m[1]}/${repo}`);
  }
  return [...repos];
}

/** Text a PDF carries for links: raw bytes plus every inflatable stream (hyperref /URI annotations live here). */
export function pdfLinkText(bytes: Buffer) {
  const raw = bytes.toString('latin1'), parts = [raw];
  const marker = /stream\r?\n/g;
  for (let m = marker.exec(raw); m; m = marker.exec(raw)) {
    const start = m.index + m[0].length, end = raw.indexOf('endstream', start);
    if (end < 0) break;
    try { parts.push(inflateSync(bytes.subarray(start, end), { finishFlush: zlibConstants.Z_SYNC_FLUSH }).toString('latin1')); } catch { /* not a Flate stream */ }
    marker.lastIndex = end;
  }
  return parts.join('\n');
}

/** Hugging Face Papers' listing for an arXiv id: the code repository and project page its authors registered. */
export async function fetchHfPaper(arxivId: string, fetcher: Fetcher = globalThis.fetch as unknown as Fetcher, timeoutMs = 15000) {
  const response = await get(fetcher, `https://huggingface.co/api/papers/${encodeURIComponent(arxivId)}`, timeoutMs);
  const data = JSON.parse(await response.text());
  return { githubRepo: typeof data.githubRepo === 'string' ? data.githubRepo : undefined, projectPage: typeof data.projectPage === 'string' ? data.projectPage : undefined };
}

/** Web links in free text other than arXiv and GitHub itself: project pages that usually carry the code button. */
export function pageLinks(text: string) {
  return [...new Set([...text.matchAll(/https?:\/\/[^\s)\]}>"',;]+/g)].map(m => m[0].replace(/[.]+$/, '')).filter(url => !/arxiv\.org|github\.com\/|doi\.org|creativecommons/i.test(url)))];
}

/** GitHub repositories linked from one web page (first 2 MB). */
export async function pageRepos(url: string, fetcher: Fetcher = globalThis.fetch as unknown as Fetcher, timeoutMs = 15000) {
  const response = await get(fetcher, url, timeoutMs);
  return githubRepos((await response.text()).slice(0, 2_000_000));
}
