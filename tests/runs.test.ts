import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareRun, submitRun, reconcileSubmission, refreshRuns, listRuns, type RunSpec, type Scheduler } from '../src/runs.js';

const exec = promisify(execFile);
async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'research-runs-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const source = path.join(root, 'source');
  const memory = path.join(root, 'memory');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'train.js'), 'console.log("original");\n');
  const spec: RunSpec = {requestId: 'run-1', projectId: 'project', experimentId: 'comparison', sourceRoot: source,
    command: [process.execPath, 'train.js'], resources: {partition: 'test', cpus: 1, memory: '1G', time: '00:05:00'}};
  return {root, source, memory, spec};
}
function scheduler(overrides: Partial<Scheduler> = {}): Scheduler {
  return {submit: async () => ({jobId: '123'}), findByName: async () => [], statuses: async () => [], ...overrides};
}
async function worker(root: string) {
  try { return await exec(process.execPath, [path.join(root, 'worker.cjs'), path.join(root, 'manifest.json')]); }
  catch (error: any) { if (typeof error.code === 'number') return {stdout: error.stdout, stderr: error.stderr, code: error.code}; throw error; }
}
async function attempts(root: string, unit = 'main') {
  const base = path.join(root, 'attempts', unit);
  return Promise.all((await fs.readdir(base)).map(async id => JSON.parse(await fs.readFile(path.join(base, id, 'attempt.json'), 'utf8'))));
}

test('snapshot captures dirty tracked and eligible untracked code, excluding data and credentials', async t => {
  const {source, memory, spec} = await fixture(t);
  await exec('git', ['init', source]);
  await exec('git', ['-C', source, 'add', 'train.js']);
  await exec('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']);
  await fs.writeFile(path.join(source, 'train.js'), 'console.log("dirty");\n');
  await fs.writeFile(path.join(source, 'idea.py'), 'print("new")\n');
  await fs.writeFile(path.join(source, '.env'), 'SECRET=no-read');
  await fs.mkdir(path.join(source, 'results'));
  await fs.writeFile(path.join(source, 'results', 'data.json'), '{"large":"artifact"}');
  const run = await prepareRun(memory, spec);
  assert.equal(run.snapshot.git.dirty, true);
  assert.notEqual(run.snapshot.git.commit, 'unknown');
  assert.deepEqual(run.snapshot.files.map(f => f.path), ['idea.py', 'train.js']);
  assert.match(await fs.readFile(path.join(run.snapshot.path, 'train.js'), 'utf8'), /dirty/);
  await fs.writeFile(path.join(source, 'train.js'), 'console.log("later");\n');
  assert.equal((await prepareRun(memory, spec)).snapshot.hash, run.snapshot.hash);
  assert.match((await worker(run.root)).stdout, /^$/);
  assert.match(await fs.readFile((await attempts(run.root))[0].stdout, 'utf8'), /dirty/);
});

test('source snapshot and inputs are checked before submit; no scheduler call on changed input', async t => {
  const {root, memory, spec} = await fixture(t);
  const checkpoint = path.join(root, 'parent.pkl');
  await fs.writeFile(checkpoint, 'checkpoint one');
  const run = await prepareRun(memory, {...spec, inputs: [{path: checkpoint, role: 'parent-checkpoint'}]});
  await fs.writeFile(checkpoint, 'checkpoint two');
  let submitted = false;
  await assert.rejects(submitRun(memory, spec.requestId, {scheduler: scheduler({submit: async () => { submitted = true; return {jobId: '99'}; }})}), /Input changed/);
  assert.equal(submitted, false);
  assert.equal((await listRuns(memory))[0].state, 'Prepared');
  await fs.writeFile(checkpoint, 'checkpoint one');
  await fs.chmod(path.join(run.snapshot.path, 'train.js'), 0o644);
  await fs.writeFile(path.join(run.snapshot.path, 'train.js'), 'tampered');
  await assert.rejects(submitRun(memory, spec.requestId), /Frozen source changed/);
});

test('a timed-out submission remains unknown, is idempotent, and reconciles by request name', async t => {
  const {memory, spec} = await fixture(t);
  const run = await prepareRun(memory, spec);
  let calls = 0;
  const fake = scheduler({submit: async () => { calls++; throw new Error('connection lost after acceptance'); },
    findByName: async name => [{jobId: '4321', name, state: 'PENDING'}]});
  assert.equal((await submitRun(memory, spec.requestId, {scheduler: fake})).state, 'Unknown');
  assert.equal((await submitRun(memory, spec.requestId, {scheduler: fake})).state, 'Unknown');
  assert.equal(calls, 1);
  const reconciled = await reconcileSubmission(memory, spec.requestId, {scheduler: fake});
  assert.equal(reconciled.jobId, '4321');
  assert.equal(reconciled.state, 'Queued');
  assert.equal(run.jobName, 'rm-run-1');
  assert.equal((await submitRun(memory, spec.requestId, {scheduler: fake})).jobId, '4321');
  assert.equal(calls, 1);
});

test('unknown submission without a receipt never becomes submit-ready', async t => {
  const {memory, spec} = await fixture(t);
  await prepareRun(memory, spec);
  await submitRun(memory, spec.requestId, {scheduler: scheduler({submit: async () => { throw new Error('timeout'); }})});
  const run = await reconcileSubmission(memory, spec.requestId, {scheduler: scheduler()});
  assert.equal(run.state, 'Unknown');
  assert.match(run.lastError!, /no new job/);
});

test('automatic retries preserve snapshot and independent attempt logs; packed units preserve partial success', async t => {
  const {source, memory, spec} = await fixture(t);
  await fs.writeFile(path.join(source, 'retry.js'), `const fs = require('node:fs');
const file = process.env.RESEARCH_OUTPUT + '/count';
const n = fs.existsSync(file) ? Number(fs.readFileSync(file)) : 0;
fs.writeFileSync(file, String(n+1)); console.log('attempt', n+1); process.exit(n ? 0 : 2);`);
  await fs.writeFile(path.join(source, 'fail.js'), 'console.error("intentional failure"); process.exit(1);');
  const run = await prepareRun(memory, {...spec, retryLimit: 1, retryDelayMs: 0, units: [
    {id: 'seed-0', command: [process.execPath, 'retry.js'], seed: 0, stage: 'train'},
    {id: 'seed-1', command: [process.execPath, 'fail.js'], seed: 1, stage: 'train'},
  ]});
  await worker(run.root);
  const states = await refreshRuns(memory, {scheduler: scheduler()});
  assert.equal(states[0].state, 'Partial');
  assert.deepEqual(states[0].execution!.units!.map(u => u.state), ['Succeeded', 'Failed']);
  const first = (await attempts(run.root, 'seed-0')).sort((a, b) => a.number - b.number);
  assert.deepEqual(first.map(a => a.exitCode), [2, 0]);
  assert.deepEqual(first.map(a => a.snapshotHash), [run.snapshot.hash, run.snapshot.hash]);
  assert.notEqual(first[0].stdout, first[1].stdout);
  assert.equal((await attempts(run.root, 'seed-1')).length, 2);
  assert.equal(await fs.readFile(path.join(run.root, 'outputs', 'seed-0', 'count'), 'utf8'), '2');
  await worker(run.root);
  assert.equal((await attempts(run.root, 'seed-0')).length, 2, 'A repeated worker invocation must not repeat completed work');
  assert.equal(await fs.readFile(path.join(run.root, 'outputs', 'seed-0', 'count'), 'utf8'), '2');
});

test('input modification by a command invalidates the attempt and prevents automatic retry', async t => {
  const {root, source, memory, spec} = await fixture(t);
  const input = path.join(root, 'input.json');
  await fs.writeFile(input, '{}');
  await fs.writeFile(path.join(source, 'modify.js'), "require('node:fs').writeFileSync(process.argv[2], 'changed');");
  const run = await prepareRun(memory, {...spec, command: [process.execPath, 'modify.js', input],
    inputs: [{path: input, role: 'dataset'}], retryLimit: 2, retryDelayMs: 0});
  await worker(run.root);
  const a = await attempts(run.root);
  assert.equal(a.length, 1);
  assert.match(a[0].error, /Input changed/);
  assert.equal((await refreshRuns(memory, {scheduler: scheduler()}))[0].state, 'Failed');
});

test('scheduler completion without worker evidence stays unknown instead of proving success', async t => {
  const {memory, spec} = await fixture(t);
  await prepareRun(memory, spec);
  const fake = scheduler({statuses: async () => [{jobId: '123', name: 'rm-run-1', state: 'COMPLETED'}]});
  await submitRun(memory, spec.requestId, {scheduler: fake});
  const run = (await refreshRuns(memory, {scheduler: fake}))[0];
  assert.equal(run.state, 'Unknown');
  assert.match(run.lastError!, /worker evidence is missing/);
});

test('request identity cannot be reused for a different experiment and unsafe paths are rejected', async t => {
  const {memory, spec} = await fixture(t);
  await prepareRun(memory, spec);
  await assert.rejects(prepareRun(memory, {...spec, experimentId: 'other'}), /different specification/);
  await assert.rejects(prepareRun(memory, {...spec, requestId: '../escape'}), /path-safe/);
});

test('new source files and launcher changes are detected before submission', async t => {
  const {memory, spec} = await fixture(t);
  const run = await prepareRun(memory, spec);
  const injected = path.join(run.snapshot.path, 'sitecustomize.py');
  await fs.writeFile(injected, 'print("unexpected")');
  await assert.rejects(submitRun(memory, spec.requestId), /file inventory/);
  await fs.unlink(injected);
  const launcher = path.join(run.root, 'submit.sh');
  await fs.chmod(launcher, 0o755);
  await fs.appendFile(launcher, '\necho changed\n');
  await assert.rejects(submitRun(memory, spec.requestId), /Frozen input changed/);
});

test('quota errors preserve evidence and stop retrying after the first attempt', async t => {
  const {source, memory, spec} = await fixture(t);
  await fs.writeFile(path.join(source, 'quota.js'), 'console.error("OSError: [Errno 122] Disk quota exceeded"); process.exit(1);');
  const run = await prepareRun(memory, {...spec, command: [process.execPath, 'quota.js'], retryLimit: 3, retryDelayMs: 0});
  await worker(run.root);
  const records = await attempts(run.root);
  assert.equal(records.length, 1);
  assert.equal(records[0].failureReason, 'quota');
  assert.match(await fs.readFile(records[0].stderr, 'utf8'), /Disk quota exceeded/);
  assert.equal((await refreshRuns(memory, {scheduler: scheduler()}))[0].state, 'Failed');
});

test('packed job preemption preserves successful units and reconstructs partial completion', async t => {
  const {source, memory, spec} = await fixture(t);
  await fs.writeFile(path.join(source, 'done.js'), "require('node:fs').writeFileSync('result.json','{}');");
  await fs.writeFile(path.join(source, 'wait.js'), 'setInterval(()=>{},1000);');
  const run = await prepareRun(memory, {...spec, units: [
    {id: 'done', command: [process.execPath, 'done.js']},
    {id: 'interrupted', command: [process.execPath, 'wait.js']},
  ]});
  const fake = scheduler({statuses: async () => [{jobId: '123', name: run.jobName, state: 'PREEMPTED'}]});
  await submitRun(memory, spec.requestId, {scheduler: fake});
  const child = spawn(process.execPath, [path.join(run.root, 'worker.cjs'), path.join(run.root, 'manifest.json')],
    {detached: true, stdio: 'ignore', env: {...process.env, SLURM_JOB_ID: '123'}});
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    const start = Date.now();
    for (;;) {
      const statuses = await Promise.all(['done', 'interrupted'].map(id => fs.readFile(path.join(run.root, 'unit-status', id + '.json'), 'utf8').then(JSON.parse).catch(() => null)));
      if (statuses[0]?.state === 'Succeeded' && statuses[1]?.state === 'Running') break;
      if (Date.now() - start > 5000) throw new Error('Fixture units did not start');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  } finally {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch (error: any) { if (error.code !== 'ESRCH') throw error; }
    await exited;
  }
  const refreshed = (await refreshRuns(memory, {scheduler: fake}))[0];
  assert.equal(refreshed.state, 'Partial');
  assert.equal(refreshed.execution!.state, 'Partial');
  assert.deepEqual(refreshed.execution!.units!.map(unit => unit.state), ['Succeeded', 'Failed']);
  assert.match(refreshed.execution!.units![1].error!, /Interrupted/);
  assert.equal((await attempts(run.root, 'done'))[0].state, 'Succeeded');
  assert.equal((await attempts(run.root, 'interrupted'))[0].state, 'Running', 'Historical receipts are not rewritten');
  await fs.unlink(path.join(run.root, 'unit-status/done.json'));
  assert.equal((await refreshRuns(memory, {scheduler: fake}))[0].state, 'Partial', 'Attempt receipts recover a missing unit status');
});

test('exit zero with a missing required artifact fails and records the missing file receipt', async t => {
  const {memory, spec} = await fixture(t);
  const run = await prepareRun(memory, {...spec, expectedArtifacts: ['report/result.json']});
  await worker(run.root);
  const result = (await refreshRuns(memory, {scheduler: scheduler()}))[0];
  assert.equal(result.state, 'Failed');
  assert.equal(result.execution!.units![0].exitCode, 0);
  assert.match(result.execution!.units![0].error!, /Missing required artifacts: report\/result.json/);
  assert.deepEqual(result.execution!.units![0].artifacts, [{relativePath: 'report/result.json',
    path: path.join(run.root, 'outputs/main/report/result.json'), state: 'missing'}]);
  assert.equal((await attempts(run.root))[0].failureReason, 'missing-artifacts');
});

test('packed artifacts retain successful evidence and report partial completion for a missing sibling output', async t => {
  const {source, memory, spec} = await fixture(t);
  await fs.writeFile(path.join(source, 'write.js'), "const fs=require('node:fs'); fs.writeFileSync('result.json','{}'); fs.writeFileSync('summary.txt','ok');");
  const run = await prepareRun(memory, {...spec, expectedArtifacts: ['result.json'], units: [
    {id: 'present', command: [process.execPath, 'write.js'], expectedArtifacts: ['summary.txt']},
    {id: 'missing', command: [process.execPath, 'train.js']},
  ]});
  await worker(run.root);
  const result = (await refreshRuns(memory, {scheduler: scheduler()}))[0];
  assert.equal(result.state, 'Partial');
  const [present, missing] = result.execution!.units!;
  assert.equal(present.state, 'Succeeded');
  assert.deepEqual(present.artifacts!.map(a => a.relativePath), ['result.json', 'summary.txt']);
  assert.ok(present.artifacts!.every(a => a.state === 'present' && a.size === 2 && /^[a-f0-9]{64}$/.test(a.hash!)));
  assert.equal(missing.state, 'Failed');
  assert.equal(missing.artifacts![0].state, 'missing');
  assert.equal(await fs.readFile(present.artifacts![0].path, 'utf8'), '{}');
});

test('artifact declarations reject traversal and escaped symlinks cannot establish success', async t => {
  const {root, source, memory, spec} = await fixture(t);
  for (const [index, file] of ['../result.json', '/tmp/result.json', 'dir/../../result.json', 'C:/escape.txt', 'dir\\escape.txt'].entries()) {
    await assert.rejects(prepareRun(memory, {...spec, requestId: `bad-artifact-${index}`, expectedArtifacts: [file]}), /relative file inside unit output/);
  }
  const external = path.join(root, 'external.json');
  await fs.writeFile(external, '{}');
  await fs.writeFile(path.join(source, 'link.js'), "require('node:fs').symlinkSync(process.argv[2],'result.json');");
  const run = await prepareRun(memory, {...spec, command: [process.execPath, 'link.js', external], expectedArtifacts: ['result.json']});
  await worker(run.root);
  const result = (await refreshRuns(memory, {scheduler: scheduler()}))[0];
  assert.equal(result.state, 'Failed');
  assert.equal(result.execution!.units![0].artifacts![0].state, 'invalid');
});

