import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { userInfo } from 'node:os';
import { workerSource } from './run-worker.js';

const exec = promisify(execFile);
const now = () => new Date().toISOString();
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const excluded = new Set(['.git', '.runs', '.venv', 'venv', 'env', 'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.cache', '.vscode', 'wandb', 'logs', 'results', 'outputs', 'artifacts', 'data', 'datasets', 'ckpts', 'checkpoints', 'exp', 'tmp', 'dist', 'build', 'benchmark', 'plot_data']);
const sourceExtensions = new Set(['.py', '.pyi', '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.sh', '.bash', '.zsh', '.md', '.txt', '.lock', '.ipynb', '.c', '.h', '.cpp', '.hpp', '.cu', '.rs', '.go', '.java', '.xml', '.html', '.css', '.svg', '.sql', '.r', '.R', '.jl']);

export type RunState = 'Prepared' | 'Submitting' | 'Unknown' | 'Queued' | 'Running' | 'Succeeded' | 'Partial' | 'Failed';
export interface RunUnit {
  id: string;
  command: string[];
  condition?: string;
  seed?: number;
  stage?: 'train' | 'eval' | string;
  expectedArtifacts?: string[];
}
export interface RunSpec {
  requestId: string;
  experimentId: string;
  projectId: string;
  sourceRoot: string;
  command: string[];
  config?: unknown;
  inputs?: { path: string; role: string }[];
  resources: { partition: string; cpus: number; memory: string; time: string; gpus?: number };
  retryLimit?: number;
  retryDelayMs?: number;
  adapter?: 'generic';
  units?: RunUnit[];
  env?: Record<string, string>;
  expectedArtifacts?: string[];
  experimentBrief?: { id: string; revision: number; contentHash: string; title: string; body: string; metadata: Record<string, unknown>; links: any[] };
}
export interface ArtifactReceipt { relativePath: string; path: string; state: 'present' | 'missing' | 'invalid'; size?: number; hash?: string; error?: string }
export interface InputIdentity { path: string; role: string; hash: string; kind: 'file' | 'directory'; bytes?: number; frozenPath?: string }
export interface SnapshotFile { path: string; hash: string; bytes: number; executable: boolean }
export interface RunRecord {
  requestId: string;
  experimentId: string;
  projectId: string;
  state: RunState;
  preparedAt: string;
  updatedAt: string;
  spec: RunSpec;
  specHash: string;
  root: string;
  jobName: string;
  jobId?: string;
  schedulerState?: string;
  submissionStartedAt?: string;
  lastError?: string;
  snapshot: { path: string; hash: string; files: SnapshotFile[]; git: { commit: string; dirty: boolean | null } };
  configHash: string;
  inputs: InputIdentity[];
  frozenInputs: {path: string; hash: string}[];
  units: (RunUnit & {resolvedCommand: string[]})[];
  warnings: string[];
  execution?: {state: RunState; jobId?: string; error?: string; units?: {id: string; state: string; attemptId?: string; exitCode?: number; error?: string; artifacts?: ArtifactReceipt[]}[]};
}
export interface SchedulerJob { jobId: string; name: string; state: string }
export interface Scheduler {
  submit(scriptPath: string, jobName: string): Promise<{jobId: string}>;
  findByName(jobName: string, since?: string): Promise<SchedulerJob[]>;
  statuses(jobIds: string[]): Promise<SchedulerJob[]>;
}
export interface RunOptions { scheduler?: Scheduler }

function validId(value: string, label = 'requestId') {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(value)) throw new Error(`${label} must be a short path-safe identifier`);
}
function runRoot(memoryRoot: string, id: string) { validId(id); return path.resolve(memoryRoot, '.runs', id); }
async function exists(file: string) { return fs.access(file).then(() => true, () => false); }
async function digest(file: string) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}
async function atomic(file: string, value: unknown) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  await fs.rename(tmp, file);
}
async function persist(run: RunRecord) { run.updatedAt = now(); await atomic(path.join(run.root, 'manifest.json'), run); return run; }
async function event(run: RunRecord, type: string, detail: Record<string, unknown> = {}) {
  await atomic(path.join(run.root, 'events', `${Date.now()}-${randomUUID()}.json`), {type, at: now(), ...detail});
}
async function load(root: string): Promise<RunRecord> { return JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8')); }
async function lock<T>(root: string, work: () => Promise<T>): Promise<T> {
  await fs.mkdir(root, {recursive: true});
  const file = path.join(root, '.operation.lock');
  try { await fs.mkdir(file); }
  catch (error: any) {
    if (error.code === 'EEXIST') throw new Error(`Another operation may be active. Inspect ${file} before retrying.`);
    throw error;
  }
  try { await atomic(path.join(file, 'owner.json'), {pid: process.pid, at: now()}); return await work(); }
  finally { await fs.rm(file, {recursive: true, force: true}); }
}
function eligible(relative: string) {
  const parts = relative.split(path.sep);
  if (parts.some(p => excluded.has(p))) return false;
  const base = parts.at(-1)!;
  if (/^\.env(?:\.|$)|credential|secret|token|\.pem$|\.key$/i.test(base)) return false;
  return sourceExtensions.has(path.extname(base)) || ['Makefile', 'Dockerfile', 'LICENSE', 'requirements', '.gitignore'].includes(base);
}
async function sourcePaths(root: string) {
  try {
    const top = (await exec('git', ['-C', root, 'rev-parse', '--show-toplevel'])).stdout.trim();
    if (await fs.realpath(top) === root) {
      const names = (await exec('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {maxBuffer: 16 * 1024 * 1024})).stdout.split('\0');
      return [...new Set(names.filter(eligible).filter(Boolean))].sort();
    }
  } catch { /* A source folder need not be a Git repository. */ }
  const files: string[] = [];
  async function walk(relative: string) {
    for (const entry of await fs.readdir(path.join(root, relative), {withFileTypes: true})) {
      if (excluded.has(entry.name)) continue;
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(name);
      else if (eligible(name)) files.push(name);
    }
  }
  await walk('');
  return files.sort();
}
async function snapshot(source: string, destination: string): Promise<RunRecord['snapshot']> {
  const files: SnapshotFile[] = [];
  let total = 0;
  await fs.mkdir(destination, {recursive: true});
  for (const relative of await sourcePaths(source)) {
    const from = path.join(source, relative);
    let stat;
    try { stat = await fs.lstat(from); } catch (error: any) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`Source symlinks require an explicit source copy: ${relative}`);
    if (!stat.isFile()) continue;
    total += stat.size;
    if (stat.size > 25 * 1024 * 1024 || total > 512 * 1024 * 1024) throw new Error(`Source snapshot is too large at ${relative}; move data to explicit inputs.`);
    const target = path.join(destination, relative);
    await fs.mkdir(path.dirname(target), {recursive: true});
    const before = await digest(from);
    await fs.copyFile(from, target);
    if (await digest(target) !== before || await digest(from) !== before) throw new Error(`Source changed while copying: ${relative}`);
    const executable = Boolean(stat.mode & 0o111);
    await fs.chmod(target, executable ? 0o555 : 0o444);
    files.push({path: relative, hash: before, bytes: stat.size, executable});
  }
  if (!files.length) throw new Error('No eligible source files found');
  for (const file of files) if (await digest(path.join(source, file.path)) !== file.hash) throw new Error(`Source changed while preparing: ${file.path}`);
  let git: RunRecord['snapshot']['git'] = {commit: 'unknown', dirty: null};
  try {
    const top = (await exec('git', ['-C', source, 'rev-parse', '--show-toplevel'])).stdout.trim();
    if (await fs.realpath(top) === source) git = {
      commit: (await exec('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim(),
      dirty: Boolean((await exec('git', ['-C', source, 'status', '--porcelain'])).stdout.trim()),
    };
  } catch { /* File hashes remain authoritative for unversioned source. */ }
  return {path: destination, hash: hash(JSON.stringify(files)), files, git};
}
async function identity(file: string): Promise<string> {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink()) throw new Error(`Input contains a symbolic link; provide its resolved file explicitly: ${file}`);
  if (stat.isFile()) return digest(file);
  if (!stat.isDirectory()) throw new Error(`Unsupported input: ${file}`);
  const entries: [string, string][] = [];
  for (const name of (await fs.readdir(file)).sort()) entries.push([name, await identity(path.join(file, name))]);
  return hash(JSON.stringify(entries));
}
async function addInput(run: RunRecord, file: string, role: string) {
  const resolved = await fs.realpath(path.resolve(run.spec.sourceRoot, file));
  const existing = run.inputs.find(i => i.path === resolved && i.role === role);
  if (existing) return existing;
  const stat = await fs.stat(resolved);
  const input: InputIdentity = {path: resolved, role, hash: await identity(resolved), kind: stat.isDirectory() ? 'directory' : 'file', bytes: stat.isFile() ? stat.size : undefined};
  run.inputs.push(input);
  return input;
}
function resolveCommand(run: RunRecord, command: string[], output: string) {
  return command.map((arg, index) => {
    let value = arg.replaceAll('{{source}}', run.snapshot.path).replaceAll('{{output}}', output).replaceAll('{{config}}', path.join(run.root, 'config.json'));
    if (value === run.spec.sourceRoot) value = run.snapshot.path;
    else if (value.startsWith(run.spec.sourceRoot + path.sep) && run.snapshot.files.some(f => f.path === path.relative(run.spec.sourceRoot, value))) value = path.join(run.snapshot.path, path.relative(run.spec.sourceRoot, value));
    if (index <= 2 && !path.isAbsolute(value) && run.snapshot.files.some(f => f.path === value)) value = path.join(run.snapshot.path, value);
    if (value.includes('{{')) throw new Error(`Unknown command placeholder: ${value}`);
    return value;
  });
}
function validateArtifacts(files: unknown) {
  if (files === undefined) return;
  if (!Array.isArray(files)) throw new Error('expectedArtifacts must be an array of relative file paths');
  for (const file of files) {
    if (typeof file !== 'string' || !file || file === '.' || path.posix.isAbsolute(file) || path.win32.isAbsolute(file) || /[\\\x00-\x1f*?\[\]]/.test(file)
      || file.split('/').includes('..') || path.posix.normalize(file) !== file || file.endsWith('/'))
      throw new Error(`Expected artifact must be a relative file inside unit output: ${String(file)}`);
  }
}
function expectedArtifacts(spec: RunSpec, unit: RunUnit, command: string[]) {
  const files = [...(spec.expectedArtifacts ?? []), ...(unit.expectedArtifacts ?? [])];
  return [...new Set(files)];
}
function validate(spec: RunSpec) {
  validId(spec.requestId);
  if (!spec.experimentId || !spec.projectId) throw new Error('experimentId and projectId are required');
  if (!Array.isArray(spec.command)) throw new Error('command must be an argument array');
  validateArtifacts(spec.expectedArtifacts);
  const r = spec.resources;
  if (!r || !/^[A-Za-z0-9_.-]+$/.test(r.partition) || !Number.isInteger(r.cpus) || r.cpus < 1 || !/^\d+(?:[KMGTP](?:B)?)?$/i.test(r.memory) || !/^(?:\d+-)?\d+(?::\d{2}){0,2}$/.test(r.time)) throw new Error('Valid Slurm partition, cpus, memory and time are required');
  if (r.gpus !== undefined && (!Number.isInteger(r.gpus) || r.gpus < 0)) throw new Error('gpus must be a nonnegative integer');
  if (!Number.isInteger(spec.retryLimit ?? 0) || (spec.retryLimit ?? 0) < 0 || (spec.retryLimit ?? 0) > 20) throw new Error('retryLimit must be between 0 and 20');
  if (!Number.isFinite(spec.retryDelayMs ?? 60000) || (spec.retryDelayMs ?? 60000) < 0) throw new Error('retryDelayMs must be nonnegative');
  const ids = new Set<string>();
  const units: RunUnit[] = spec.units ?? [{id: 'main', command: spec.command}];
  for (const unit of units) {
    validId(unit.id, 'unit id');
    if (ids.has(unit.id)) throw new Error(`Duplicate unit id: ${unit.id}`);
    ids.add(unit.id);
    validateArtifacts(unit.expectedArtifacts);
    if (!unit.command.length || unit.command.some(v => typeof v !== 'string' || v.includes('\0'))) throw new Error('Each unit requires a nonempty command argument array');
  }
  if (!ids.size) throw new Error('At least one execution unit is required');
  for (const [key, value] of Object.entries(spec.env ?? {})) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || /TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY/i.test(key)) throw new Error(`Do not persist secrets in run environment: ${key}`);
}
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
function launchScript(run: RunRecord) {
  const r = run.spec.resources;
  return ['#!/bin/bash', `#SBATCH --job-name=${run.jobName}`, `#SBATCH --partition=${r.partition}`, `#SBATCH --cpus-per-task=${r.cpus}`, `#SBATCH --mem=${r.memory}`, `#SBATCH --time=${r.time}`,
    ...(r.gpus ? [`#SBATCH --gres=gpu:${r.gpus}`] : []), '#SBATCH --no-requeue',
    `#SBATCH --output=${quote(path.join(run.root, 'scheduler-%j.out'))}`, `#SBATCH --error=${quote(path.join(run.root, 'scheduler-%j.err'))}`,
    'set -eu', `exec ${quote(process.execPath)} ${quote(path.join(run.root, 'worker.cjs'))} ${quote(path.join(run.root, 'manifest.json'))}`, ''].join('\n');
}

export async function prepareRun(memoryRoot: string, spec: RunSpec): Promise<RunRecord> {
  validate(spec);
  const root = runRoot(memoryRoot, spec.requestId);
  const canonical = {...spec, sourceRoot: await fs.realpath(spec.sourceRoot)};
  const specHash = hash(JSON.stringify(canonical));
  return lock(root, async () => {
    if (await exists(path.join(root, 'manifest.json'))) {
      const run = await load(root);
      if (run.specHash !== specHash) throw new Error('requestId already belongs to a different specification');
      return run;
    }
    if (await exists(path.join(root, 'snapshot'))) throw new Error('An incomplete preparation exists; retain it for inspection and use a new requestId.');
    const run: RunRecord = {requestId: spec.requestId, experimentId: spec.experimentId, projectId: spec.projectId,
      spec: canonical, specHash, root, state: 'Prepared', preparedAt: now(), updatedAt: now(), jobName: `rm-${spec.requestId}`,
      snapshot: await snapshot(canonical.sourceRoot, path.join(root, 'snapshot')), configHash: '', inputs: [], frozenInputs: [], units: [], warnings: []};
    for (const name of ['inputs', 'outputs', 'attempts', 'events', 'unit-status']) await fs.mkdir(path.join(root, name), {recursive: true});
    for (const input of spec.inputs ?? []) await addInput(run, input.path, input.role);
    const configFile = path.join(root, 'config.json');
    await atomic(configFile, spec.config ?? {});
    run.configHash = await digest(configFile);
    await fs.chmod(configFile, 0o444);
    for (const unit of spec.units ?? [{id: 'main', command: spec.command}]) {
      const output = path.join(root, 'outputs', unit.id);
      await fs.mkdir(output, {recursive: true});
      const command = unit.command;
      run.units.push({...unit, expectedArtifacts: expectedArtifacts(spec, unit, command), resolvedCommand: resolveCommand(run, command, output)});
      if ((/^(?:ba|z|fi|da|k)?sh$/.test(path.basename(command[0])) || command.slice(1).some(arg => ['-c', '-e', '--eval'].includes(arg))))
        run.warnings.push(`${unit.id}: Shell or inline commands may access hardcoded paths outside the snapshot. Only the recorded source files and declared inputs are verified.`);
    }
    await fs.writeFile(path.join(root, 'worker.cjs'), workerSource, {mode: 0o444});
    await fs.writeFile(path.join(root, 'submit.sh'), launchScript(run), {mode: 0o555});
    for (const file of ['worker.cjs', 'submit.sh']) run.frozenInputs.push({path: path.join(root, file), hash: await digest(path.join(root, file))});
    await atomic(path.join(root, 'events', `${Date.now()}-prepared.json`), {type: 'Prepared', at: now(), snapshotHash: run.snapshot.hash});
    return persist(run);
  });
}

async function verify(run: RunRecord) {
  const actual: string[] = [];
  async function walk(relative: string) {
    for (const entry of await fs.readdir(path.join(run.snapshot.path, relative), {withFileTypes: true})) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) actual.push(name);
      else throw new Error(`Frozen source changed: ${name}`);
    }
  }
  await walk('');
  if (JSON.stringify(actual.sort()) !== JSON.stringify(run.snapshot.files.map(f => f.path).sort())) throw new Error('Frozen source changed: file inventory');
  for (const f of run.snapshot.files) if (await digest(path.join(run.snapshot.path, f.path)) !== f.hash) throw new Error(`Frozen source changed: ${f.path}`);
  for (const input of run.inputs) if (!input.frozenPath && await identity(input.path) !== input.hash) throw new Error(`Input changed: ${input.role} (${input.path})`);
  const realRoot = await fs.realpath(run.root);
  for (const input of run.frozenInputs) {
    const stat = await fs.lstat(input.path);
    if (!stat.isFile() || await fs.realpath(input.path) !== path.join(realRoot, path.relative(run.root, input.path)) || await digest(input.path) !== input.hash) throw new Error(`Frozen input changed: ${input.path}`);
  }
  if (await digest(path.join(run.root, 'config.json')) !== run.configHash) throw new Error('Frozen configuration changed');
}
export async function submitRun(memoryRoot: string, requestId: string, options: RunOptions = {}): Promise<RunRecord> {
  const root = runRoot(memoryRoot, requestId);
  return lock(root, async () => {
    const run = await load(root);
    if (run.state !== 'Prepared') return run;
    await verify(run);
    run.state = 'Submitting'; run.submissionStartedAt = now();
    await persist(run);
    await event(run, 'SubmissionStarted', {jobName: run.jobName});
    try {
      const result = await (options.scheduler ?? slurmScheduler).submit(path.join(root, 'submit.sh'), run.jobName);
      if (!/^\d+(?:_\d+)?$/.test(result.jobId)) throw new Error('Scheduler response did not contain a valid job ID');
      run.jobId = result.jobId; run.state = 'Queued';
    } catch (error) {
      run.state = 'Unknown'; run.lastError = `Submission outcome is unknown. Reconcile before any retry: ${String(error)}`;
    }
    await persist(run);
    await event(run, 'SubmissionRecorded', {state: run.state, jobId: run.jobId, error: run.lastError});
    return run;
  });
}
function schedulerState(value: string): RunState {
  const state = value.split(/[ +]/)[0];
  if (['RUNNING', 'COMPLETING'].includes(state)) return 'Running';
  if (['PENDING', 'CONFIGURING', 'REQUEUED', 'SUSPENDED'].includes(state)) return 'Queued';
  if (state === 'COMPLETED') return 'Unknown';
  if (['FAILED', 'CANCELLED', 'TIMEOUT', 'NODE_FAIL', 'OUT_OF_MEMORY', 'PREEMPTED', 'BOOT_FAIL', 'DEADLINE'].includes(state)) return 'Failed';
  return 'Unknown';
}
export async function reconcileSubmission(memoryRoot: string, requestId: string, options: RunOptions = {}): Promise<RunRecord> {
  const root = runRoot(memoryRoot, requestId);
  return lock(root, async () => {
    const run = await load(root);
    if (run.jobId || !['Unknown', 'Submitting'].includes(run.state)) return run;
    const matches = await (options.scheduler ?? slurmScheduler).findByName(run.jobName, run.submissionStartedAt);
    const unique = [...new Map(matches.map(j => [j.jobId, j])).values()];
    if (unique.length === 1) { run.jobId = unique[0].jobId; run.state = schedulerState(unique[0].state); delete run.lastError; }
    else { run.state = 'Unknown'; run.lastError = unique.length ? 'Multiple jobs match this request. Inspect scheduler history; no new job was submitted.' : 'No scheduler receipt found yet. Submission remains unknown; no new job was submitted.'; }
    await persist(run);
    await event(run, 'SubmissionReconciled', {state: run.state, jobId: run.jobId, error: run.lastError});
    return run;
  });
}
export async function listRuns(memoryRoot: string): Promise<RunRecord[]> {
  const base = path.resolve(memoryRoot, '.runs');
  if (!await exists(base)) return [];
  const runs: RunRecord[] = [];
  for (const entry of await fs.readdir(base, {withFileTypes: true})) {
    if (entry.isDirectory() && await exists(path.join(base, entry.name, 'manifest.json'))) runs.push(await load(path.join(base, entry.name)));
  }
  return runs.sort((a, b) => b.preparedAt.localeCompare(a.preparedAt));
}
type UnitEvidence = NonNullable<NonNullable<RunRecord['execution']>['units']>[number];
async function unitEvidence(run: RunRecord, unit: RunUnit, worker?: RunRecord['execution']): Promise<UnitEvidence> {
  try {
    const saved = JSON.parse(await fs.readFile(path.join(run.root, 'unit-status', `${unit.id}.json`), 'utf8'));
    if (saved.id === unit.id && ['Running', 'Succeeded', 'Failed'].includes(saved.state)) return saved;
  } catch { /* A killed older worker may only have an attempt receipt. */ }
  const base = path.join(run.root, 'attempts', unit.id);
  const attempts: any[] = [];
  for (const entry of await fs.readdir(base, {withFileTypes: true}).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    try {
      const attempt = JSON.parse(await fs.readFile(path.join(base, entry.name, 'attempt.json'), 'utf8'));
      if (attempt.unitId === unit.id && attempt.snapshotHash === run.snapshot.hash) attempts.push(attempt);
    } catch { /* Incomplete receipts never establish success. */ }
  }
  attempts.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)) || b.number - a.number);
  const latest = attempts[0];
  if (latest) return {id: unit.id, state: latest.state, attemptId: latest.id, exitCode: latest.exitCode, error: latest.error, artifacts: latest.artifacts};
  return worker?.units?.find(entry => entry.id === unit.id) ?? {id: unit.id, state: 'Unknown'};
}
export async function refreshRuns(memoryRoot: string, options: RunOptions = {}): Promise<RunRecord[]> {
  const runs = await listRuns(memoryRoot);
  const active = runs.filter(r => r.jobId && ['Queued', 'Running', 'Unknown', 'Submitting'].includes(r.state));
  let jobs: SchedulerJob[] = [];
  let schedulerError: string | undefined;
  if (active.length) {
    try { jobs = await (options.scheduler ?? slurmScheduler).statuses(active.map(r => r.jobId!)); }
    catch (error) { schedulerError = String(error); }
  }
  for (const item of runs) await lock(item.root, async () => {
    const run = await load(item.root);
    const file = path.join(run.root, 'worker-status.json');
    const worker: RunRecord['execution'] = await exists(file) ? JSON.parse(await fs.readFile(file, 'utf8')) : undefined;
    if (!run.jobId && worker?.jobId && /^\d+(?:_\d+)?$/.test(worker.jobId)) run.jobId = worker.jobId;
    if (worker?.error) run.lastError = worker.error;
    const job = jobs.find(j => j.jobId === run.jobId);
    if (job) run.schedulerState = job.state;
    const scheduler = run.schedulerState?.split(/[ +]/)[0];
    const stopped = scheduler && ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT', 'NODE_FAIL', 'OUT_OF_MEMORY', 'PREEMPTED', 'BOOT_FAIL', 'DEADLINE'].includes(scheduler);
    if (worker || run.jobId) {
      const units = await Promise.all(run.units.map(unit => unitEvidence(run, unit, worker)));
      if (stopped) for (const unit of units) {
        if (['Succeeded', 'Failed'].includes(unit.state)) continue;
        unit.state = scheduler === 'COMPLETED' ? 'Unknown' : 'Failed';
        unit.error = `Interrupted or missing completion evidence: scheduler state ${scheduler}. Previous attempt records were retained.`;
      }
      const successes = units.filter(unit => unit.state === 'Succeeded').length;
      const allFinished = units.every(unit => ['Succeeded', 'Failed'].includes(unit.state));
      const workerFinished = worker && ['Succeeded', 'Partial', 'Failed'].includes(worker.state);
      if (stopped || allFinished || workerFinished) {
        run.state = successes === units.length ? 'Succeeded' : successes ? 'Partial'
          : units.every(unit => unit.state === 'Failed') || worker?.state === 'Failed' ? 'Failed' : 'Unknown';
        if (run.state === 'Unknown') run.lastError = 'Scheduler finished but worker evidence is missing; result is unknown.';
      } else run.state = worker?.state === 'Running' ? 'Running' : scheduler ? schedulerState(scheduler) : run.state;
      run.execution = {...worker, state: run.state, units};
    }
    if (schedulerError && active.some(r => r.requestId === run.requestId)) run.lastError = `Scheduler refresh unavailable: ${schedulerError}`;
    await persist(run);
  });
  return listRuns(memoryRoot);
}
function parseJobs(text: string): SchedulerJob[] {
  return text.split('\n').filter(Boolean).flatMap(line => {
    const [jobId, name, state] = line.trim().split('|');
    return /^\d+(?:_\d+)?$/.test(jobId) && name && state ? [{jobId, name, state}] : [];
  });
}
async function accountJobs(args: string[]) {
  const result = await exec('sacct', ['-n', '-P', '-X', '--format=JobIDRaw,JobName%128,State', ...args], {timeout: 20000, maxBuffer: 4 * 1024 * 1024});
  return parseJobs(result.stdout);
}
export const slurmScheduler: Scheduler = {
  async submit(scriptPath) {
    const {stdout} = await exec('sbatch', ['--parsable', scriptPath], {timeout: 30000});
    return {jobId: stdout.trim().split(';')[0]};
  },
  async findByName(jobName, since) {
    const [queue, accounting] = await Promise.all([
      exec('squeue', ['-h', '-o', '%i|%j|%T', '--user', userInfo().username, '--name', jobName], {timeout: 20000}).then(r => parseJobs(r.stdout)),
      accountJobs(['--user', userInfo().username, '--starttime', since?.slice(0, 10) ?? 'today', '--name', jobName]),
    ]);
    return [...queue, ...accounting].filter(j => j.name === jobName);
  },
  async statuses(jobIds) { return jobIds.length ? accountJobs(['--jobs', jobIds.join(',')]) : []; },
};
