import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { readReportStatus, syncReport } from '../src/integrations/report.js';
import { createAuthSession, DriveError, GoogleDrive, type DriveTokens } from '../src/integrations/drive.js';
import { buildCodeGraph } from '../src/integrations/code-map.js';

const execute = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execute('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd })).stdout;
async function repoFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'research-report-'));
  const remote = path.join(root, 'remote.git'), repo = path.join(root, 'local'), other = path.join(root, 'other');
  await git(root, 'init', '--bare', remote);
  await git(root, 'init', repo);
  await git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  await writeFile(path.join(repo, 'paper.tex'), 'initial\n');
  await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'initial');
  await git(repo, 'remote', 'add', 'origin', remote); await git(repo, 'push', '-u', 'origin', 'main');
  await git(root, 'clone', '-b', 'main', remote, other);
  return { root, remote, repo, other };
}

test('Report fast-forwards clean workspaces and preserves dirty edits', async t => {
  const { root, repo, other } = await repoFixture(); t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal((await readReportStatus(repo)).state, 'clean');
  await writeFile(path.join(other, 'paper.tex'), 'remote revision\n');
  await git(other, 'commit', '-am', 'remote update'); await git(other, 'push', 'origin', 'main');
  assert.equal((await syncReport(repo)).state, 'clean');
  assert.equal(await readFile(path.join(repo, 'paper.tex'), 'utf8'), 'remote revision\n');
  await writeFile(path.join(repo, 'paper.tex'), 'my unfinished edit\n');
  assert.equal((await syncReport(repo)).state, 'dirty');
  assert.equal(await readFile(path.join(repo, 'paper.tex'), 'utf8'), 'my unfinished edit\n');
});

test('Report preserves diverged histories and reports unreachable remotes', async t => {
  const { root, repo, other } = await repoFixture(); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(other, 'paper.tex'), 'remote change\n');
  await git(other, 'commit', '-am', 'remote'); await git(other, 'push', 'origin', 'main');
  await writeFile(path.join(repo, 'local.tex'), 'local change\n');
  await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'local');
  const before = await git(repo, 'rev-parse', 'HEAD');
  assert.equal((await syncReport(repo)).state, 'diverged');
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), before);
  await git(repo, 'remote', 'set-url', 'origin', path.join(root, 'missing.git'));
  assert.equal((await syncReport(repo)).state, 'offline');
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), before);
});

const json = (value: any, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function driveFixture(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>, expired = false) {
  let tokens: DriveTokens | undefined = { accessToken: 'initial', refreshToken: 'refresh', expiresAt: expired ? 1 : Date.now() + 3600_000 };
  const drive = new GoogleDrive({ clientId: 'desktop-client', getTokens: async () => tokens, setTokens: async value => { tokens = value; }, fetch: (async (input: any, init?: RequestInit) => handler(new URL(input instanceof Request ? input.url : input.toString()), init)) as typeof fetch });
  return { drive, tokens: () => tokens };
}

test('Drive paginates shared folders and searches children without filtering out their parent folders', async () => {
  const visited: URL[] = [];
  const { drive } = driveFixture(url => {
    visited.push(url);
    if (url.pathname.endsWith('/root')) return json({ id: 'root', name: 'Project', mimeType: 'application/vnd.google-apps.folder', driveId: 'shared' });
    assert.equal(url.searchParams.get('supportsAllDrives'), 'true');
    assert.equal(url.searchParams.get('driveId'), 'shared');
    if (url.searchParams.get('q')!.startsWith("'child'")) return json({ files: [{ id: 'slides', name: 'Weekly slides', mimeType: 'application/vnd.google-apps.presentation' }] });
    if (url.searchParams.has('pageToken')) return json({ files: [{ id: 'pdf', name: 'Paper', mimeType: 'application/pdf' }] });
    return json({ nextPageToken: 'next', files: [{ id: 'child', name: 'Meetings', mimeType: 'application/vnd.google-apps.folder' }] });
  });
  const files = await drive.listFolder('root', { query: 'slides', mimeType: 'application/vnd.google-apps.presentation' });
  assert.deepEqual(files.map(file => file.path), ['Project/Meetings/Weekly slides']);
  assert.equal(drive.getCachedFiles('root')!.files.length, 3);
  assert.equal(visited.length, 4);
});

test('Drive refreshes expired tokens and reports revocation without storing credentials in its file cache', async () => {
  let tokenCalls = 0;
  const fixture = driveFixture((url, init) => {
    if (url.pathname === '/token') { tokenCalls++; return json({ access_token: 'renewed', expires_in: 3600 }); }
    assert.equal((init!.headers as Record<string, string>).Authorization, 'Bearer renewed');
    if (url.pathname.endsWith('/root')) return json({ id: 'root', name: 'Project', mimeType: 'application/vnd.google-apps.folder' });
    return json({ files: [] });
  }, true);
  await fixture.drive.listFolder('root');
  assert.equal(tokenCalls, 1); assert.equal(fixture.tokens()!.refreshToken, 'refresh');
  assert.doesNotMatch(JSON.stringify(fixture.drive.getCachedFiles('root')), /renewed|refreshToken/);
  const revoked = driveFixture(() => json({ error: 'invalid_grant' }, 400), true);
  await assert.rejects(revoked.drive.listFolder('root'), (error: any) => error.code === 'auth');
  assert.equal(revoked.tokens(), undefined);
});

test('Drive retries a 401 once, preserves partial output on permission changes, and detects repeated page tokens', async () => {
  let deniedOnce = false;
  const auth = driveFixture(url => {
    if (url.pathname === '/token') return json({ access_token: 'second', expires_in: 3600 });
    if (!deniedOnce) { deniedOnce = true; return json({}, 401); }
    if (url.pathname.endsWith('/root')) return json({ id: 'root', name: 'Project', mimeType: 'application/vnd.google-apps.folder' });
    return json({ files: [] });
  });
  assert.deepEqual(await auth.drive.listFolder('root'), []);
  const denied = driveFixture(url => {
    if (url.pathname.endsWith('/root')) return json({ id: 'root', name: 'Project', mimeType: 'application/vnd.google-apps.folder' });
    if (url.searchParams.get('q')!.startsWith("'child'")) return json({}, 403);
    return json({ files: [{ id: 'child', name: 'Restricted', mimeType: 'application/vnd.google-apps.folder' }] });
  });
  await assert.rejects(denied.drive.listFolder('root'), (error: DriveError) => error.code === 'permission' && error.partialFiles.length === 1);
  const repeated = driveFixture(url => url.pathname.endsWith('/root') ? json({ id: 'root', name: 'Project', mimeType: 'application/vnd.google-apps.folder' }) : json({ files: [], nextPageToken: 'same' }));
  await assert.rejects(repeated.drive.listFolder('root'), (error: DriveError) => error.code === 'pagination');
});

test('Desktop OAuth uses PKCE and validates response state before exchanging the code', async () => {
  const session = createAuthSession('desktop-client', 'http://127.0.0.1:54891/callback');
  const url = new URL(session.url);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(session.verifier.length >= 43);
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.metadata.readonly');
  assert.throws(() => createAuthSession('desktop-client', 'https://remote.example/callback'), /loopback/);
  let requests = 0;
  const fixture = driveFixture((_url, init) => {
    requests++;
    assert.equal((init!.body as URLSearchParams).get('code_verifier'), session.verifier);
    return json({ access_token: 'signed-in', refresh_token: 'new-refresh', expires_in: 3600 });
  });
  await assert.rejects(fixture.drive.exchangeCode(session, 'code', 'wrong'), /does not match/);
  assert.equal(requests, 0);
  await fixture.drive.exchangeCode(session, 'code', session.state);
  assert.equal(fixture.tokens()!.refreshToken, 'new-refresh');
});

test('Code maps parse source without importing it, resolve local calls, and detect changed revisions', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'research-code-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'main.py'), '"""Training entrypoint."""\nfrom model import predict\nraise RuntimeError("must never execute")\ndef main():\n    return predict()\n');
  await writeFile(path.join(root, 'model.py'), 'def predict():\n    """Return a prediction."""\n    return 1\n');
  await writeFile(path.join(root, 'launch.sh'), '#!/bin/sh\npython3 main.py\n');
  const modules = await buildCodeGraph(root, 'modules');
  assert.ok(modules.edges.some(edge => edge.source === 'main.py' && edge.target === 'model.py'));
  assert.ok(modules.edges.some(edge => edge.source === 'launch.sh' && edge.target === 'main.py'));
  const calls = await buildCodeGraph(root, 'data');
  assert.ok(calls.edges.some(edge => edge.source === 'main.py:main' && edge.target === 'model.py:predict'));
  assert.equal(calls.nodes.find(node => node.id === 'main.py:main')!.source!.line, 4);
  await writeFile(path.join(root, 'model.py'), 'def predict():\n    return 2\n');
  const changed = await buildCodeGraph(root, 'data', { previousRevision: calls.revision });
  assert.notEqual(changed.revision, calls.revision); assert.equal(changed.stale, true);
  for (const node of changed.nodes) if (node.source?.path) assert.ok((await readFile(node.source.path, 'utf8')).split('\n').length >= node.source.line!);
});

