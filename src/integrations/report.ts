import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export type ReportState = 'clean' | 'dirty' | 'ahead' | 'behind' | 'diverged' | 'offline' | 'unconfigured' | 'error';
export interface ReportStatus {
  repo: string;
  branch: string;
  remote: string;
  state: ReportState;
  ahead: number;
  behind: number;
  changedFiles: string[];
  ignoredBuildFiles?: string[];
  lastFetchedAt?: string;
  message?: string;
  lastSyncedAt?: string;
}

async function git(repo: string, args: string[]): Promise<string> {
  const result = await execute('git', ['-c', 'credential.interactive=false', ...args], {
    cwd: repo, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout.trimEnd();
}

function message(error: unknown): string {
  return String((error as Error).message ?? error).replace(/https?:\/\/[^\s/@]+@/g, 'https://[redacted]@');
}

function checkRemote(remote: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remote)) throw new Error('Invalid Git remote name.');
}

const buildOutput = /\.(aux|log|out|toc|lof|lot|fls|fdb_latexmk|synctex\.gz|synctex|bbl|blg|bcf|run\.xml|nav|snm|vrb|xdv|dvi)$|(^|\/)_minted/;

export async function readReportStatus(repo: string, remote = 'origin'): Promise<ReportStatus> {
  checkRemote(remote);
  const status: ReportStatus = { repo, branch: '', remote, state: 'error', ahead: 0, behind: 0, changedFiles: [] };
  try {
    status.branch = await git(repo, ['symbolic-ref', '--short', 'HEAD']);
    const entries = (await git(repo, ['status', '--porcelain=v1', '-z'])).split('\0').filter(Boolean);
    const untracked: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      // Untracked LaTeX build output never blocks a sync; new sources (.tex, .bib, figures) still count as local work.
      (entries[i].startsWith('??') && buildOutput.test(entries[i].slice(3)) ? untracked : status.changedFiles).push(entries[i].slice(3));
      if (entries[i][0] === 'R' || entries[i][0] === 'C') i++;
    }
    if (untracked.length) status.ignoredBuildFiles = untracked.slice(0, 20);
    try { await git(repo, ['config', '--get', `remote.${remote}.url`]); }
    catch { return status.changedFiles.length ? { ...status, state: 'dirty', message: 'Local edits are preserved. Commit or stash them before syncing.' } : { ...status, state: 'unconfigured', message: `Remote ${remote} is not configured.` }; }
    const { stat } = await import('node:fs/promises');
    const fetchHead = await git(repo, ['rev-parse', '--git-path', 'FETCH_HEAD']).catch(() => '');
    const fetched = fetchHead ? await stat(fetchHead.startsWith('/') ? fetchHead : `${repo}/${fetchHead}`).catch(() => undefined) : undefined;
    if (fetched) status.lastFetchedAt = fetched.mtime.toISOString();
    const ref = `refs/remotes/${remote}/${status.branch}`;
    try {
      const counts = (await git(repo, ['rev-list', '--left-right', '--count', `HEAD...${ref}`, '--'])).split(/\s+/).map(Number);
      [status.ahead, status.behind] = counts;
    } catch { return status.changedFiles.length ? { ...status, state: 'dirty', message: 'Local edits are preserved. Commit or stash them before syncing.' } : { ...status, state: 'unconfigured', message: 'Fetch the remote branch before syncing.' }; }
    if (status.changedFiles.length) return { ...status, state: 'dirty', message: 'Local edits are preserved. Commit or stash them before syncing.' };
    status.state = status.ahead && status.behind ? 'diverged' : status.ahead ? 'ahead' : status.behind ? 'behind' : 'clean';
    if (status.state === 'diverged') status.message = 'Local and remote edits diverged. Resolve them in Git before syncing.';
    else status.message = `${status.ahead ? `${status.ahead} local commit(s) not yet published; the researcher publishes from the Report page. ` : ''}Counts are as of the last fetch${status.lastFetchedAt ? ` (${status.lastFetchedAt})` : ''}; sync to see new Overleaf edits.`;
    return status;
  } catch (error) { return { ...status, state: 'error', message: message(error) }; }
}

const operations = new Map<string, Promise<ReportStatus>>();
function serialize(repo: string, operation: () => Promise<ReportStatus>): Promise<ReportStatus> {
  const next = (operations.get(repo) ?? Promise.resolve()).then(operation, operation);
  operations.set(repo, next);
  void next.finally(() => { if (operations.get(repo) === next) operations.delete(repo); }).catch(() => {});
  return next;
}

export function syncReport(repo: string, remote = 'origin'): Promise<ReportStatus> {
  return serialize(repo, async () => {
    let status = await readReportStatus(repo, remote);
    if (status.state === 'dirty' || status.state === 'error') return status;
    try { await git(repo, ['config', '--get', `remote.${remote}.url`]); }
    catch { return status; }
    try { await git(repo, ['fetch', '--no-tags', remote]); }
    catch (error) { return { ...status, state: 'offline', message: `Could not fetch. Local content is preserved. ${message(error)}` }; }
    status = await readReportStatus(repo, remote);
    let pulled: { commit: string; subject: string }[] = [];
    if (status.state === 'behind') {
      const log = await git(repo, ['log', '--format=%h %s', `HEAD..refs/remotes/${remote}/${status.branch}`]).catch(() => '');
      pulled = log.split('\n').filter(Boolean).map(line => ({ commit: line.slice(0, line.indexOf(' ')), subject: line.slice(line.indexOf(' ') + 1) }));
      try { await git(repo, ['merge', '--ff-only', '--no-edit', `refs/remotes/${remote}/${status.branch}`]); }
      catch (error) { return { ...await readReportStatus(repo, remote), message: message(error) }; }
      status = await readReportStatus(repo, remote);
    }
    return { ...status, pulled, ...(pulled.length ? { message: `Pulled ${pulled.length} Overleaf commit(s). ${status.message ?? ''}`.trim() } : {}), lastSyncedAt: new Date().toISOString() };
  });
}

export function pushReport(repo: string, remote = 'origin'): Promise<ReportStatus> {
  return serialize(repo, async () => {
    const status = await readReportStatus(repo, remote);
    if (!['clean', 'ahead'].includes(status.state)) return { ...status, message: status.message ?? 'Sync and resolve local changes before publishing.' };
    try {
      await git(repo, ['push', remote, `HEAD:refs/heads/${status.branch}`]);
      return { ...await readReportStatus(repo, remote), message: 'Published to Overleaf.' };
    } catch (error) { return { ...status, state: 'error', message: `Publish failed. Local content is preserved. ${message(error)}` }; }
  });
}

// Section-level reading of a LaTeX clone, modelled on Overleaf MCP servers' get_sections/get_section_content:
// agents read the outline, then one section, instead of whole files.
const headingPattern = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{(.+?)\}\s*(?:%.*)?$/;
const levels: Record<string, number> = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 };
export interface ReportHeading { file: string; line: number; level: string; title: string }

async function texFiles(repo: string, dir = ''): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(`${repo}/${dir}`, { withFileTypes: true });
  const nested = await Promise.all(entries.filter(entry => !entry.name.startsWith('.')).map(entry => {
    const relative = dir ? `${dir}/${entry.name}` : entry.name;
    return entry.isDirectory() ? texFiles(repo, relative) : /\.(tex|bib)$/.test(entry.name) ? [relative] : [];
  }));
  return nested.flat().sort();
}

async function reportFile(repo: string, file: string) {
  const { readFile, realpath } = await import('node:fs/promises');
  const root = await realpath(repo);
  const full = await realpath(`${repo}/${file}`).catch(() => { throw new Error(`No file ${file} in the report. Call the outline for the list of files.`); });
  if (!full.startsWith(`${root}/`) || !/\.(tex|bib)$/.test(full)) throw new Error('Only .tex and .bib files inside the report can be read.');
  return (await readFile(full, 'utf8')).split('\n');
}

export async function reportOutline(repo: string) {
  const files = await texFiles(repo);
  const headings: ReportHeading[] = [];
  for (const file of files.filter(name => name.endsWith('.tex'))) (await reportFile(repo, file)).forEach((text, index) => {
    const match = headingPattern.exec(text);
    if (match) headings.push({ file, line: index + 1, level: match[1], title: match[2].trim() });
  });
  return { files, headings };
}

/** One section (heading to the next heading of the same or higher level), or a line window of the file. */
export async function readReport(repo: string, file: string, options: { section?: string; line?: number; offset?: number; limit?: number } = {}) {
  const lines = await reportFile(repo, file);
  const limit = options.limit ?? 200;
  let start = options.offset ?? 0, end = lines.length, ambiguous: number[] | undefined;
  if (options.section) {
    const wanted = options.section.trim().toLowerCase();
    const headings = lines.map((text, index) => ({ index, match: headingPattern.exec(text) })).filter(h => h.match);
    const exact = headings.filter(h => h.match![2].trim().toLowerCase() === wanted);
    const matches = exact.length ? exact : headings.filter(h => h.match![2].toLowerCase().includes(wanted));
    const found = options.line ? matches.find(h => h.index + 1 === options.line) : matches[0];
    if (!found) throw new Error(options.line ? `No section "${options.section}" starts at line ${options.line} of ${file}. Call the outline for headings and lines.` : `No section "${options.section}" in ${file}. Call the outline for section titles.`);
    if (matches.length > 1 && !options.line) ambiguous = matches.map(h => h.index + 1);
    start = found.index + (options.offset ?? 0);
    end = headings.find(h => h.index > found.index && levels[h.match![1]] <= levels[found.match![1]])?.index ?? lines.length;
  }
  const window = lines.slice(start, Math.min(end, start + limit));
  return { file, firstLine: start + 1, lastLine: start + window.length, totalLines: lines.length, truncated: start + window.length < end, ...(ambiguous ? { ambiguous: `Several sections match (lines ${ambiguous.join(', ')}); this is the one at line ${ambiguous[0]}. Pass line to choose another.` } : {}), text: window.join('\n') };
}
