import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ResearchStore } from '../src/store.js';
import { ResearchService } from '../src/service.js';
import { arxivIdFrom, githubRepo, paperKey, paperFromBib, parseArxivAtom, parseBibtex, parsePaperLink, type Fetcher } from '../src/integrations/papers.js';

const ATOM = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
<entry><id>http://arxiv.org/abs/2506.04168v3</id><published>2025-06-04T17:00:00Z</published>
<title>Horizon Reduction Makes
  RL Scalable</title><summary>  We study the scalability of offline RL &amp; find that horizon matters.  </summary>
<author><name>Seohong Park</name></author><author><name>Kevin Frans</name></author><author><name>Sergey Levine</name></author>
<arxiv:primary_category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/></entry></feed>`;
const EMPTY_ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Error</title></entry></feed>`;

function fakeFetch(routes: Record<string, { status?: number; body?: string; bytes?: Buffer }>, seen: string[] = []): Fetcher {
  return async url => {
    seen.push(url);
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))?.[1];
    if (!route) return { ok: false, status: 404, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
    const status = route.status ?? 200;
    return { ok: status < 400, status, text: async () => route.body ?? '', arrayBuffer: async () => { const b = route.bytes ?? Buffer.alloc(0); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer; } };
  };
}

async function fixture(fetcher: Fetcher) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-papers-'));
  const store = await new ResearchStore(path.join(dir, 'memory'), path.join(dir, 'cache')).init();
  await store.create({ kind: 'Project', id: 'project-a', title: 'Project A', status: 'Active' });
  await store.create({ kind: 'Project', id: 'project-b', title: 'Project B', status: 'Active' });
  return { dir, store, service: new ResearchService(store, undefined, fetcher), async close() { store.close(); await fs.rm(dir, { recursive: true, force: true }); } };
}

const GITHUB = { 'https://api.github.com/repos/seohongpark/horizon-reduction': { body: JSON.stringify({ html_url: 'https://github.com/seohongpark/horizon-reduction', full_name: 'seohongpark/horizon-reduction', description: 'Horizon reduction code', stargazers_count: 120, pushed_at: '2025-08-01T00:00:00Z' }) } };
const ARXIV = { 'https://export.arxiv.org/api/query?id_list=2506.04168': { body: ATOM } };

test('paper links: arXiv IDs from abs/pdf/html URLs and bare IDs; GitHub repos; duplicate keys', () => {
  for (const input of ['https://arxiv.org/abs/2506.04168', 'https://arxiv.org/pdf/2506.04168v3', 'https://arxiv.org/pdf/2506.04168.pdf', 'arxiv.org/html/2506.04168v2'.replace(/^/, 'https://'), '2506.04168', 'arXiv:2506.04168v1'])
    assert.equal(arxivIdFrom(input), '2506.04168', input);
  assert.equal(arxivIdFrom('https://arxiv.org/abs/cs/0101001v2'), 'cs/0101001');
  assert.equal(arxivIdFrom('https://example.org/abs/2506.04168'), undefined);
  assert.deepEqual(parsePaperLink('https://openreview.net/forum?id=abc'), { kind: 'web', url: 'https://openreview.net/forum?id=abc' });
  assert.throws(() => parsePaperLink('ftp://x/y'), /web links/);
  assert.equal(githubRepo('https://github.com/seohongpark/horizon-reduction/tree/master/agents')?.url, 'https://github.com/seohongpark/horizon-reduction');
  assert.equal(githubRepo('https://gitlab.com/a/b'), undefined);
  assert.equal(paperKey({ arxivId: '2506.04168' }), paperKey({ arxivId: '2506.04168', paperUrl: 'https://x' }));
  assert.equal(paperKey({ paperUrl: 'https://www.example.org/p/' }), paperKey({ paperUrl: 'https://example.org/p' }));
});

test('arXiv Atom parsing: whitespace, entities, authors, year, BibTeX; missing records are reported', () => {
  const m = parseArxivAtom(ATOM, '2506.04168');
  assert.equal(m.title, 'Horizon Reduction Makes RL Scalable');
  assert.deepEqual(m.authors, ['Seohong Park', 'Kevin Frans', 'Sergey Levine']);
  assert.equal(m.year, 2025);
  assert.equal(m.abstract, 'We study the scalability of offline RL & find that horizon matters.');
  assert.equal(m.pdfUrl, 'https://arxiv.org/pdf/2506.04168');
  assert.match(m.bibtex!, /^@misc\{park2025horizon,/);
  assert.match(m.bibtex!, /author = \{Seohong Park and Kevin Frans and Sergey Levine\}/);
  assert.match(m.bibtex!, /primaryClass = \{cs\.LG\}/);
  assert.throws(() => parseArxivAtom(EMPTY_ATOM, '9999.99999'), /no record/);
});

test('addPaper fills arXiv and GitHub metadata, sends only the links, and keeps papers per project', async () => {
  const seen: string[] = [];
  const f = await fixture(fakeFetch({ ...ARXIV, ...GITHUB }, seen));
  try {
    const paper = await f.service.addPaper({ projectId: 'project-a', url: 'https://arxiv.org/pdf/2506.04168v3', codeUrls: ['https://github.com/seohongpark/horizon-reduction'], tags: [' scaling ', ''], notes: 'Borrow K=25.' }, 'human');
    assert.equal(paper.kind, 'Paper');
    assert.equal(paper.status, 'To read');
    assert.deepEqual(paper.projectIds, ['project-a']);
    assert.equal(paper.title, 'Horizon Reduction Makes RL Scalable');
    assert.equal(paper.metadata.arxivId, '2506.04168');
    assert.equal(paper.metadata.paperUrl, 'https://arxiv.org/abs/2506.04168');
    assert.deepEqual(paper.metadata.tags, ['scaling']);
    assert.equal(paper.metadata.code[0].name, 'seohongpark/horizon-reduction');
    assert.equal(paper.metadata.code[0].stars, 120);
    assert.equal(paper.body, 'Borrow K=25.');
    assert.equal(paper.metadata.title, undefined, 'the title lives in the record, not duplicated in metadata');
    assert.ok(seen.every(url => url.startsWith('https://export.arxiv.org/') || url.startsWith('https://api.github.com/')));
    await assert.rejects(f.service.addPaper({ projectId: 'project-a', url: '2506.04168' }), /already in Project A/);
    const copy = await f.service.addPaper({ projectId: 'project-b', url: '2506.04168' });
    assert.notEqual(copy.id, paper.id);
    assert.equal(f.store.list('project-a', 'Paper').length, 1);
    assert.equal(f.store.list('project-b', 'Paper').length, 1);
    assert.match(await fs.readFile(paper.filePath!, 'utf8'), /kind: Paper/);
  } finally { await f.close(); }
});

test('addPaper: a failed lookup needs a manual title; non-arXiv links need a title; GitHub failures keep the link', async () => {
  const f = await fixture(fakeFetch({ 'https://export.arxiv.org/': { status: 503 }, 'https://api.github.com/': { status: 403 } }));
  try {
    await assert.rejects(f.service.addPaper({ projectId: 'project-a', url: '2506.04168' }), /Could not read arXiv metadata.*503.*Enter the title/);
    const manual = await f.service.addPaper({ projectId: 'project-a', url: '2506.04168', title: 'Horizon reduction (manual)', codeUrls: ['https://github.com/a/b'] });
    assert.match(manual.metadata.fetchError, /503/);
    assert.equal(manual.metadata.arxivId, '2506.04168');
    assert.equal(manual.metadata.code[0].url, 'https://github.com/a/b');
    assert.match(manual.metadata.code[0].fetchError, /403/);
    await assert.rejects(f.service.addPaper({ projectId: 'project-a', url: 'https://openreview.net/forum?id=xyz' }), /Enter a title/);
    const web = await f.service.addPaper({ projectId: 'project-a', url: 'https://openreview.net/forum?id=xyz', title: 'An OpenReview paper' });
    assert.equal(web.metadata.paperUrl, 'https://openreview.net/forum?id=xyz');
    await assert.rejects(f.service.addPaper({ projectId: 'missing', url: '2506.04168', title: 't' }), /not found/);
  } finally { await f.close(); }
});

test('paper records: exactly one project, reading statuses, web links only', async () => {
  const f = await fixture(fakeFetch({}));
  try {
    await assert.rejects(f.store.create({ kind: 'Paper', title: 'Two projects', projectIds: ['project-a', 'project-b'] }), /exactly one project/);
    await assert.rejects(f.store.create({ kind: 'Paper', title: 'Bad status', projectIds: ['project-a'], status: 'Inbox' }), /status must be one of/);
    await assert.rejects(f.store.create({ kind: 'Paper', title: 'Bad link', projectIds: ['project-a'], metadata: { paperUrl: 'file:///etc/passwd' } }), /web links/);
    const paper = await f.store.create({ kind: 'Paper', title: 'Fine', projectIds: ['project-a'] });
    assert.equal(paper.status, 'To read');
    const read = await f.store.update(paper.id, { status: 'Read' }, { expectedRevision: paper.revision, expectedHash: paper.contentHash! });
    assert.equal(read.status, 'Read');
    const cleared = await f.store.update(paper.id, { metadata: { arxivId: '2506.04168', pdfUrl: 'https://arxiv.org/pdf/2506.04168' } }, { expectedRevision: read.revision, expectedHash: read.contentHash! })
      .then(p => f.store.update(p.id, { metadata: { arxivId: null, pdfUrl: null } }, { expectedRevision: p.revision, expectedHash: p.contentHash! }));
    assert.equal(cleared.metadata.arxivId, null, 'metadata merges; null (as sent by the editor) clears a fetched field');
    assert.equal(paperKey(cleared.metadata), undefined);
    await assert.rejects(f.store.update(paper.id, { metadata: { pdf: { path: '../escape.pdf' } } }, { expectedRevision: cleared.revision, expectedHash: cleared.contentHash! }), /library folder/);
  } finally { await f.close(); }
});

test('PDFs are stored under library/<project>/, validated, hashed, and downloadable from arXiv', async () => {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048, 7)]);
  const f = await fixture(fakeFetch({ ...ARXIV, 'https://arxiv.org/pdf/2506.04168': { bytes: pdf } }));
  try {
    const paper = await f.service.addPaper({ projectId: 'project-a', url: '2506.04168' });
    const edit = (p: any) => ({ expectedRevision: p.revision, expectedHash: p.contentHash, actor: 'human' as const });
    await assert.rejects(f.store.attachPaperPdf(paper.id, Buffer.from('<html>not a pdf'), 'x.pdf', edit(paper)), /not a PDF/);
    await assert.rejects(f.store.attachPaperPdf(paper.id, Buffer.alloc(0), 'x.pdf', edit(paper)), /between 1 byte/);
    const stored = await f.store.attachPaperPdf(paper.id, pdf, '/home/someone/Downloads/hr.pdf', edit(paper));
    assert.equal(stored.metadata.pdf.path, `library/project-a/${paper.id}.pdf`);
    assert.equal(stored.metadata.pdf.originalName, 'hr.pdf');
    assert.equal(stored.metadata.pdf.bytes, pdf.length);
    assert.deepEqual(await fs.readFile(f.store.paperPdfPath(stored)!), pdf);
    await assert.rejects(f.store.attachPaperPdf(paper.id, pdf, 'stale.pdf', edit(paper)), /changed/, 'stale revisions are rejected');
    const other = await f.service.addPaper({ projectId: 'project-b', url: '2506.04168' });
    const downloaded = await f.service.fetchPaperPdf(other.id, edit(other));
    assert.equal(downloaded.metadata.pdf.path, `library/project-b/${other.id}.pdf`);
    const manual = await f.store.create({ kind: 'Paper', title: 'No arXiv', projectIds: ['project-a'] });
    await assert.rejects(f.service.fetchPaperPdf(manual.id, edit(manual)), /Upload the PDF instead/);
    await assert.rejects(f.service.command({ command: 'openPaperPdf', payload: { id: manual.id } }), /No PDF/);
  } finally { await f.close(); }
});

test('UI commands: addPaper keeps the client ID; uploads require the displayed version', async () => {
  const pdf = Buffer.from('%PDF-1.4\nbody');
  const opened: string[] = [];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-papers-ui-'));
  const store = await new ResearchStore(path.join(dir, 'memory'), path.join(dir, 'cache')).init();
  try {
    await store.create({ kind: 'Project', id: 'project-a', title: 'Project A', status: 'Active' });
    const service = new ResearchService(store, { openSource: async source => { opened.push(source.path!); } }, fakeFetch(ARXIV));
    await service.command({ command: 'addPaper', payload: { id: 'paper-fixed-id', projectId: 'project-a', url: '2506.04168', codeUrls: [], tags: [] } });
    const paper = store.get('paper-fixed-id');
    assert.equal(paper.metadata.authors.length, 3);
    await assert.rejects(service.command({ command: 'uploadPaperPdf', payload: { id: paper.id, name: 'a.pdf', dataBase64: pdf.toString('base64') } }), /displayed record version/);
    await service.command({ command: 'uploadPaperPdf', payload: { id: paper.id, name: 'a.pdf', dataBase64: pdf.toString('base64'), expectedRevision: paper.revision, expectedHash: paper.contentHash } });
    await service.command({ command: 'openPaperPdf', payload: { id: paper.id } });
    assert.equal(opened[0], path.join(store.root, 'library', 'project-a', 'paper-fixed-id.pdf'));
    const state = await service.command({ command: 'selectSection', payload: { section: 'Related work' } });
    assert.equal(state.section, 'Related work');
  } finally { store.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('BibTeX import: arXiv entries fetch metadata, other entries keep their own BibTeX, duplicates skip, bad entries fail alone', async () => {
  const bib = `@comment{ignored}
@misc{park2025horizon,
  title = {Horizon {Reduction} Makes RL Scalable},
  author = {Park, Seohong and Frans, Kevin},
  eprint = {2506.04168}, archivePrefix = {arXiv}, year = {2025}
}
@inproceedings{doe2024world,
  title = "A {World} Model, with commas",
  author = {Doe, Jane and Roe, Richard},
  booktitle = {ICLR}, year = 2024, doi = {10.1000/xyz}
}
@misc{broken, note = {no title or link}}`;
  const entries = parseBibtex(bib);
  assert.deepEqual(entries.map(e => e.key), ['park2025horizon', 'doe2024world', 'broken']);
  assert.deepEqual(paperFromBib(entries[1]), { url: 'https://doi.org/10.1000/xyz', title: 'A World Model, with commas', bibtexKey: 'doe2024world', bibtex: entries[1].raw, authors: ['Jane Doe', 'Richard Roe'], year: 2024, venue: 'ICLR', unbalanced: undefined });
  const f = await fixture(fakeFetch(ARXIV));
  try {
    const first = await f.service.importPapers({ projectId: 'project-a', bibtex: bib, tags: ['bib'] });
    assert.deepEqual(first.created.map(p => [p.title, p.metadata.bibtexKey, p.status]), [['Horizon Reduction Makes RL Scalable', 'park2025horizon', 'To read'], ['A World Model, with commas', 'doe2024world', 'To read']]);
    assert.equal(first.created[1].metadata.bibtex, entries[1].raw);
    assert.equal(first.failed.length, 1);
    const again = await f.service.importPapers({ projectId: 'project-a', bibtex: bib, urls: ['https://arxiv.org/abs/2506.04168'] });
    assert.deepEqual([again.created.length, again.skipped.length], [0, 3]);
  } finally { await f.close(); }
});

test('BibTeX import finds Google Scholar arXiv ids, survives unclosed braces, and deduplicates by key and title', async () => {
  const bib = `@article{scholar2025,
  title = {Horizon reduction makes {RL} scalable},
  author = {Park, Seohong},
  journal = {arXiv preprint arXiv:2506.04168},
  year = {2025}
}
@inproceedings{broken2025,
  title = {An entry whose braces never close,
  year = {2025}
@misc{after2024, title = {Still Imported}, url = {https://example.org/after}}`;
  const entries = parseBibtex(bib);
  assert.deepEqual(entries.map(e => [e.key, !!e.unbalanced]), [['scholar2025', false], ['broken2025', true], ['after2024', false]]);
  assert.equal(paperFromBib(entries[0]).url, 'https://arxiv.org/abs/2506.04168');
  const f = await fixture(fakeFetch(ARXIV));
  try {
    const first = await f.service.importPapers({ projectId: 'project-a', bibtex: bib });
    assert.deepEqual(first.created.map(p => [p.metadata.arxivId ?? null, p.metadata.bibtexKey]), [['2506.04168', 'scholar2025'], [null, 'after2024']]);
    assert.match(first.created[0].metadata.bibtex, /^@\w+\{scholar2025,/);
    assert.deepEqual(first.failed.map(x => [x.title, x.reason]), [['broken2025', 'Unbalanced braces in this BibTeX entry; fix the .bib and import again.']]);
    const again = await f.service.importPapers({ projectId: 'project-a', bibtex: bib, urls: ['https://arxiv.org/abs/2506.04168'] });
    assert.equal(again.created.length, 0);
    assert.ok(again.skipped.every(s => s.id));
    await assert.rejects(f.service.addPaper({ projectId: 'project-a', title: 'STILL imported!' }), /already in Project A/);
    await assert.rejects(f.service.addPaper({ projectId: 'project-a', url: 'https://doi.org/10.1/x' }), /DOI links are not looked up/);
  } finally { await f.close(); }
});

test('arXiv decides title and authors; a mismatched BibTeX title is returned as a warning', async () => {
  const f = await fixture(fakeFetch(ARXIV));
  try {
    const result = await f.service.importPapers({ projectId: 'project-a', bibtex: '@article{wrong2025, title = {Something Unrelated}, author = {Somebody and others}, journal = {arXiv preprint arXiv:2506.04168}}' });
    assert.deepEqual([result.created[0].title, result.created[0].metadata.authors], ['Horizon Reduction Makes RL Scalable', ['Seohong Park', 'Kevin Frans', 'Sergey Levine']]);
    assert.deepEqual(result.warnings.map(w => w.givenTitle), ['Something Unrelated']);
    const doi = await f.service.importPapers({ projectId: 'project-a', urls: ['https://doi.org/10.1/x'] });
    assert.match(doi.failed[0].reason, /research_add_paper with a title/);
  } finally { await f.close(); }
});

test('one paper from its name: arXiv search, stored PDF, and code found in the paper or left unconfirmed', async () => {
  const deflate = (await import('node:zlib')).deflateSync;
  const pdf = (links: string) => Buffer.concat([Buffer.from('%PDF-1.5\n1 0 obj << /Length 9 /Filter /FlateDecode >>\nstream\n'), deflate(Buffer.from(links)), Buffer.from('\nendstream\nendobj\n%%EOF')]);
  const SEARCH = `<feed><entry><id>http://arxiv.org/abs/2506.04168v3</id><title>Horizon Reduction Makes RL Scalable</title></entry></feed>`;
  const routes = (pdfLinks: string, hf?: string) => ({
    'https://export.arxiv.org/api/query?search_query=': { body: SEARCH }, ...ARXIV,
    'https://arxiv.org/pdf/2506.04168': { bytes: pdf(pdfLinks) },
    ...(hf ? { 'https://huggingface.co/api/papers/2506.04168': { body: JSON.stringify({ githubRepo: hf, projectPage: 'https://example.org/hr' }) } } : {}),
    'https://api.github.com/repos/': { body: JSON.stringify({ html_url: 'https://github.com/seohongpark/horizon-reduction', full_name: 'seohongpark/horizon-reduction', description: 'Code', stargazers_count: 5 }) },
  });
  const agreed = await fixture(fakeFetch(routes('/URI (https://github.com/seohongpark/horizon-reduction) /URI (https://github.com/other/baseline)', 'https://github.com/seohongpark/horizon-reduction')));
  try {
    const result = await agreed.service.collectPaper({ projectId: 'project-a', paper: 'horizon reduction makes RL scalable' });
    assert.equal(result.paper.metadata.arxivId, '2506.04168');
    assert.ok(result.pdf.stored && result.pdf.path?.endsWith('.pdf'));
    assert.deepEqual([result.code.result, result.code.attached.map((c: { url: string }) => c.url), result.code.unconfirmed.map(c => c.url)], ['found', ['https://github.com/seohongpark/horizon-reduction'], ['https://github.com/other/baseline']]);
    assert.deepEqual(result.paper.metadata.code[0].foundIn, ['pdf', 'huggingface']);
    assert.deepEqual(result.paper.metadata.codeSearch.checked, ['given', 'abstract', 'pdf', 'huggingface']);
    const none = await agreed.service.setPaperCode(result.paper.id, [], 'No release statement in the paper.', { expectedRevision: result.paper.revision, expectedHash: result.paper.contentHash! });
    assert.deepEqual([none.metadata.code, none.metadata.codeSearch.result, none.metadata.codeSearch.reason], [[], 'none', 'No release statement in the paper.']);
  } finally { await agreed.close(); }
  const pdfOnly = await fixture(fakeFetch(routes('/URI (https://github.com/seohongpark/horizon-reduction)')));
  try {
    const result = await pdfOnly.service.collectPaper({ projectId: 'project-a', paper: '2506.04168' });
    assert.deepEqual([result.code.result, result.code.attached], ['unconfirmed', []]);
    // Asking for it again completes it: by name it is found locally, the code is searched again because it was unconfirmed.
    const again = await pdfOnly.service.collectPaper({ projectId: 'project-a', paper: 'Horizon Reduction Makes RL Scalable' });
    assert.deepEqual([again.existing, again.paper.id, again.pdf.stored], [true, result.paper.id, true]);
    const settled = await pdfOnly.service.setPaperCode(again.paper.id, [], 'checked', { expectedRevision: again.paper.revision, expectedHash: again.paper.contentHash! });
    const third = await pdfOnly.service.collectPaper({ projectId: 'project-a', paper: '2506.04168' });
    assert.deepEqual([third.existing, third.code.result, third.paper.revision], [true, 'none', settled.revision]);
    const { unlinkSync } = await import('node:fs');
    unlinkSync(pdfOnly.store.paperPdfPath(third.paper)!);
    const { lint } = await import('../src/lint.js');
    const missing = lint(pdfOnly.store.list(), 'project-a', new Date(), 15, paper => !!pdfOnly.store.paperPdfPath(paper) && (require('node:fs') as typeof import('node:fs')).existsSync(pdfOnly.store.paperPdfPath(paper)!));
    assert.ok(missing.issues.find(i => i.rule === 'paper-no-pdf')?.records.some(r => r.id === third.paper.id));
    const restored = await pdfOnly.service.collectPaper({ projectId: 'project-a', paper: '2506.04168' });
    assert.equal(restored.pdf.stored, true);
    await assert.rejects(pdfOnly.service.collectPaper({ projectId: 'project-a', paper: 'A paper nobody wrote' }), /No exact arXiv title match .*Candidates: Horizon Reduction Makes RL Scalable \(2506\.04168\)/);
  } finally { await pdfOnly.close(); }
});

test('code named on the authors\' project page is followed one step and attached', async () => {
  const ATOM_PAGE = ATOM.replace('horizon matters.', 'horizon matters. Project page: https://horizon.example.org');
  const f = await fixture(fakeFetch({
    'https://export.arxiv.org/api/query?id_list=2506.04168': { body: ATOM_PAGE },
    'https://arxiv.org/pdf/2506.04168': { bytes: Buffer.from('%PDF-1.5 /URI (https://github.com/old/previous-version) %%EOF') },
    'https://horizon.example.org': { body: '<a href="https://github.com/seohongpark/horizon-reduction">Code</a>' },
    'https://api.github.com/repos/': { body: JSON.stringify({ html_url: 'https://github.com/seohongpark/horizon-reduction', full_name: 'seohongpark/horizon-reduction', stargazers_count: 1 }) },
  }));
  try {
    const result = await f.service.collectPaper({ projectId: 'project-a', paper: 'https://arxiv.org/abs/2506.04168' });
    assert.deepEqual(result.code.attached, [{ url: 'https://github.com/seohongpark/horizon-reduction', foundIn: ['project-page'] }]);
    assert.deepEqual(result.code.unconfirmed.map(c => c.url), ['https://github.com/old/previous-version']);
    assert.equal(result.paper.metadata.projectPage, 'https://horizon.example.org');
  } finally { await f.close(); }
});
