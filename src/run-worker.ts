export const workerSource = String.raw`#!/usr/bin/env node
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const os = require('node:os');
const root = path.dirname(process.argv[2]);
const now = () => new Date().toISOString();
const hash = data => createHash('sha256').update(data).digest('hex');
async function digest(file) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}
async function atomic(file, value) {
  const tmp = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await fs.rename(tmp, file);
}
async function event(type, detail = {}) {
  await atomic(path.join(root, 'events', Date.now() + '-' + randomUUID() + '.json'), {type, at:now(), ...detail});
}
async function identity(file) {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink()) throw new Error('Input became a symbolic link: ' + file);
  if (stat.isFile()) return digest(file);
  if (!stat.isDirectory()) throw new Error('Unsupported input: ' + file);
  const entries = [];
  for (const name of (await fs.readdir(file)).sort()) entries.push([name, await identity(path.join(file, name))]);
  return hash(JSON.stringify(entries));
}
async function verify(manifest) {
  async function names(dir, prefix = '') {
    const found = [];
    for (const name of (await fs.readdir(dir)).sort()) {
      const relative = prefix ? path.join(prefix,name) : name;
      const stat = await fs.lstat(path.join(dir,name));
      if (stat.isDirectory()) found.push(...await names(path.join(dir,name),relative));
      else if (stat.isFile()) found.push(relative);
      else throw new Error('Frozen source changed: ' + relative);
    }
    return found;
  }
  if (JSON.stringify((await names(manifest.snapshot.path)).sort()) !== JSON.stringify(manifest.snapshot.files.map(f=>f.path).sort()))
    throw new Error('Frozen source changed: file inventory');
  for (const f of manifest.snapshot.files) {
    if (await digest(path.join(manifest.snapshot.path, f.path)) !== f.hash)
      throw new Error('Frozen source changed: ' + f.path);
  }
  for (const input of manifest.inputs) {
    if (!input.frozenPath && await identity(input.path) !== input.hash) throw new Error('Input changed: ' + input.role + ' (' + input.path + ')');
  }
  const realRoot = await fs.realpath(root);
  for (const input of manifest.frozenInputs) {
    const stat = await fs.lstat(input.path);
    if (!stat.isFile() || await fs.realpath(input.path) !== path.join(realRoot,path.relative(root,input.path)) || await digest(input.path) !== input.hash)
      throw new Error('Frozen input changed: ' + input.path);
  }
  if (await digest(path.join(root, 'config.json')) !== manifest.configHash) throw new Error('Frozen configuration changed');
}
async function capture(command, args, file, env) {
  return new Promise(resolve => {
    const child = spawn(command, args, {env, stdio:['ignore', 'pipe', 'pipe']});
    let output = '';
    child.stdout.on('data', b => { if (output.length < 2000000) output += b; });
    child.stderr.on('data', b => { if (output.length < 2000000) output += b; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 15000);
    child.once('error', async e => { clearTimeout(timer); await fs.writeFile(file, String(e)).catch(()=>{}); resolve(); });
    child.once('close', async () => { clearTimeout(timer); await fs.writeFile(file, output).catch(()=>{}); resolve(); });
  });
}
async function quotaFailure(attempt) {
  if (/EDQUOT|ENOSPC|disk quota exceeded|no space left on device/i.test(attempt.error || '')) return true;
  for (const file of [attempt.stderr,attempt.stdout]) {
    if (!file) continue;
    const handle = await fs.open(file,'r').catch(()=>null);
    if (!handle) continue;
    try {
      const {size} = await handle.stat();
      const bytes = Buffer.alloc(Math.min(size,16384));
      await handle.read(bytes,0,bytes.length,Math.max(0,size-bytes.length));
      if (/EDQUOT|ENOSPC|disk quota exceeded|no space left on device/i.test(bytes.toString())) return true;
    } finally { await handle.close(); }
  }
  return false;
}
async function artifactReceipts(output, expected) {
  const receipts = [];
  const plannedOutput = path.join(await fs.realpath(root),path.relative(root,output));
  for (const relativePath of expected || []) {
    const file = path.join(output,relativePath);
    const receipt = {relativePath,path:file,state:'missing'};
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || await fs.realpath(file) !== path.join(plannedOutput,relativePath)) {
        receipt.state = 'invalid'; receipt.error = 'Expected a regular file inside the unit output, without symlinks.';
      } else {
        receipt.state = 'present'; receipt.size = stat.size; receipt.hash = await digest(file);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') { receipt.state = 'invalid'; receipt.error = String(error); }
    }
    receipts.push(receipt);
  }
  return receipts;
}
async function runUnit(manifest, unit) {
  const output = path.join(root, 'outputs', unit.id);
  await fs.mkdir(output, {recursive:true});
  const baseEnv = {...process.env, ...manifest.spec.env, RESEARCH_RUN_ID:manifest.requestId,
    RESEARCH_SOURCE:manifest.snapshot.path, RESEARCH_OUTPUT:output, RESEARCH_CONFIG:path.join(root,'config.json'),
    PYTHONDONTWRITEBYTECODE:'1', PYTHONFAULTHANDLER:'1', TMPDIR:path.join(output,'tmp')};
  await fs.mkdir(baseEnv.TMPDIR, {recursive:true});
  let final;
  for (let n = 0; n <= (manifest.spec.retryLimit || 0); n++) {
    const attempt = {id:randomUUID(), unitId:unit.id, number:n+1, startedAt:now(), state:'Running',
      jobId:process.env.SLURM_JOB_ID || null, snapshotHash:manifest.snapshot.hash,
      command:unit.resolvedCommand, host:os.hostname(), environment:{node:process.version, platform:process.platform,
      condaPrefix:process.env.CONDA_PREFIX || null, cudaVisibleDevices:process.env.CUDA_VISIBLE_DEVICES || null}};
    const dir = path.join(root, 'attempts', unit.id, attempt.id);
    await fs.mkdir(dir, {recursive:true});
    const statusPath = path.join(dir,'attempt.json');
    attempt.stdout = path.join(dir,'stdout.log'); attempt.stderr = path.join(dir,'stderr.log');
    await atomic(statusPath, attempt);
    await atomic(path.join(root,'unit-status',unit.id+'.json'), {id:unit.id,state:'Running',attemptId:attempt.id,startedAt:attempt.startedAt});
    await event('AttemptStarted', {unitId:unit.id, attemptId:attempt.id, number:attempt.number});
    try {
      await verify(manifest);
      if (/python[^/]*$/.test(path.basename(unit.resolvedCommand[0]))) {
        await capture(unit.resolvedCommand[0], ['-m','pip','freeze','--all'], path.join(dir,'dependencies.txt'), baseEnv);
        await capture(unit.resolvedCommand[0], ['--version'], path.join(dir,'runtime.txt'), baseEnv);
      }
      const stdout = await fs.open(attempt.stdout,'wx');
      const stderr = await fs.open(attempt.stderr,'wx');
      let result;
      try {
        result = await new Promise((resolve,reject) => {
          const child = spawn(unit.resolvedCommand[0], unit.resolvedCommand.slice(1),
            {cwd:output, env:baseEnv, stdio:['ignore',stdout.fd,stderr.fd]});
          child.once('error', reject);
          child.once('close', (exitCode, signal) => resolve({exitCode,signal}));
        });
      } finally { await stdout.close(); await stderr.close(); }
      Object.assign(attempt,result);
      await verify(manifest);
      attempt.state = attempt.exitCode === 0 ? 'Succeeded' : 'Failed';
    } catch (error) {
      attempt.state = 'Failed'; attempt.error = String(error); attempt.exitCode ??= 1;
    }
    attempt.artifacts = await artifactReceipts(output,unit.expectedArtifacts);
    const missing = attempt.artifacts.filter(artifact => artifact.state !== 'present');
    if (attempt.state === 'Succeeded' && missing.length) {
      attempt.state = 'Failed'; attempt.failureReason = 'missing-artifacts';
      attempt.error = 'Missing required artifacts: ' + missing.map(artifact => artifact.relativePath).join(', ');
    }
    if (attempt.state === 'Failed' && await quotaFailure(attempt)) {
      attempt.failureReason = 'quota';
      attempt.error = 'Disk quota or storage capacity exhausted. Automatic retries stopped; logs and outputs were retained.';
    }
    attempt.finishedAt = now();
    await atomic(statusPath, attempt);
    const stop = attempt.state === 'Succeeded' || attempt.failureReason === 'quota' || /changed:|configuration changed/.test(attempt.error || '');
    const retry = !stop && n < (manifest.spec.retryLimit || 0);
    await atomic(path.join(root,'unit-status',unit.id+'.json'), {id:unit.id,state:retry?'Running':attempt.state,
      attemptId:attempt.id,exitCode:attempt.exitCode,error:attempt.error,artifacts:attempt.artifacts,finishedAt:attempt.finishedAt,retrying:retry});
    await event('AttemptFinished', {unitId:unit.id, attemptId:attempt.id, state:attempt.state, exitCode:attempt.exitCode});
    final = attempt;
    if (stop) break;
    if (n < (manifest.spec.retryLimit || 0)) await new Promise(r => setTimeout(r, manifest.spec.retryDelayMs ?? 60000));
  }
  return {id:unit.id, state:final.state, attemptId:final.id, exitCode:final.exitCode, error:final.error,artifacts:final.artifacts};
}
async function main() {
  const manifest = JSON.parse(await fs.readFile(process.argv[2],'utf8'));
  const lock = path.join(root,'worker.lock');
  await fs.mkdir(path.join(root,'unit-status'),{recursive:true});
  try { await fs.mkdir(lock); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another worker may exist; refusing duplicate execution. Inspect worker.lock.');
    throw error;
  }
  await atomic(path.join(lock,'owner.json'), {pid:process.pid,host:os.hostname(),jobId:process.env.SLURM_JOB_ID || null,startedAt:now()});
  try {
    const previous = await fs.readFile(path.join(root,'worker-status.json'),'utf8').then(JSON.parse, error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (previous && ['Succeeded','Partial','Failed'].includes(previous.state)) {
      process.exitCode = previous.state === 'Succeeded' ? 0 : 1;
      return;
    }
    await verify(manifest);
    await atomic(path.join(root,'worker-status.json'), {state:'Running',startedAt:now(),jobId:process.env.SLURM_JOB_ID || null});
    const results = await Promise.allSettled(manifest.units.map(unit => runUnit(manifest,unit)));
    const units = results.map((result,index) => result.status === 'fulfilled' ? result.value :
      {id:manifest.units[index].id,state:'Failed',error:String(result.reason)});
    const successes = units.filter(u => u.state === 'Succeeded').length;
    const state = successes === units.length ? 'Succeeded' : successes ? 'Partial' : 'Failed';
    await atomic(path.join(root,'worker-status.json'), {state,finishedAt:now(),units,jobId:process.env.SLURM_JOB_ID || null});
    await event('RunFinished',{state,units});
    process.exitCode = state === 'Succeeded' ? 0 : 1;
  } catch (error) {
    await atomic(path.join(root,'worker-status.json'), {state:'Failed',finishedAt:now(),error:String(error),jobId:process.env.SLURM_JOB_ID || null}).catch(()=>{});
    throw error;
  } finally { await fs.rm(lock,{recursive:true,force:true}); }
}
main().catch(async error => {
  process.stderr.write(String(error) + '\n');
  await event('WorkerError',{error:String(error)}).catch(()=>{});
  process.exitCode = 1;
});
`;
