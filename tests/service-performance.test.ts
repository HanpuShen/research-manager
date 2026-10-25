import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';
import {ResearchStore} from '../src/store.js';
import {ResearchService} from '../src/service.js';
import {GoogleDrive} from '../src/integrations/drive.js';

const execute = promisify(execFile);
async function fixture(t: any) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'research-navigation-'));
  const store = await new ResearchStore(path.join(root, 'memory'), path.join(root, 'cache')).init();
  t.after(async () => { store.close(); await rm(root, {recursive:true,force:true}); });
  return {root, store, service:new ResearchService(store)};
}

test('ordinary navigation and cached snapshots do not wait for indexing or reread Drive credentials', async t => {
  const {store, service} = await fixture(t);
  await store.create({id:'project-a',kind:'Project',title:'Project'});
  let tokenReads = 0;
  service.drive = new GoogleDrive({clientId:'test',getTokens:async () => { tokenReads++; return {accessToken:'test',expiresAt:Date.now()+3600_000}; },setTokens:async () => {}});
  await service.snapshot();
  const initialReads = tokenReads, reindex = store.reindex.bind(store);
  let release!: () => void, indexCalls = 0;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  store.reindex = async () => { indexCalls++; await waiting; await reindex(); };
  const refresh = service.snapshot();
  try {
    for (const section of ['Ideas','Experiments','Overview']) {
      let settled = false;
      const navigation = service.command({command:'selectSection',payload:{section}}).then(state => { settled = true; return state; });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(settled, true, `${section} should complete while the refresh is still waiting`);
      assert.equal((await navigation).section, section);
    }
    assert.equal((await service.snapshot({cached:true})).driveConnected, true);
    assert.equal(indexCalls, 1);
    assert.equal(tokenReads, initialReads);
  } finally { release(); await refresh; }
});

test('navigation keeps cached records and runs while an explicit snapshot discovers external edits', async t => {
  const {store, service} = await fixture(t);
  await store.create({id:'project-a',kind:'Project',title:'Project'});
  const idea = await store.create({id:'idea-a',kind:'Idea',title:'Original idea',projectIds:['project-a']});
  const runRoot = path.join(store.root,'.runs','run-a');
  await mkdir(runRoot,{recursive:true});
  const manifest = path.join(runRoot,'manifest.json');
  const run = {requestId:'run-a',projectId:'project-a',preparedAt:new Date().toISOString(),state:'Running'};
  await writeFile(manifest,JSON.stringify(run));
  await service.snapshot();
  await writeFile(idea.filePath!,(await readFile(idea.filePath!,'utf8')).replace('Original idea','Edited externally'));
  await writeFile(manifest,JSON.stringify({...run,state:'Succeeded'}));
  const cached = await service.command({command:'selectSection',payload:{section:'Experiments'}});
  assert.equal(cached.entities.find(entity => entity.id === idea.id)?.title,'Original idea');
  assert.equal(cached.runs?.[0].state,'Running');
  const refreshed = await service.snapshot();
  assert.equal(refreshed.entities.find(entity => entity.id === idea.id)?.title,'Edited externally');
  assert.equal(refreshed.runs?.[0].state,'Succeeded');
  await assert.rejects(service.command({command:'saveEntity',payload:{entity:{id:idea.id,title:'Stale edit'},expectedRevision:idea.revision,expectedHash:idea.contentHash}}),/changed/);
});

test('source navigation reuses maps and explicit refresh detects changed files', async t => {
  const {root,store,service} = await fixture(t);
  const source = path.join(root,'source');
  await mkdir(source);
  const file = path.join(source,'main.py');
  await writeFile(file,'def original(): return 1\n');
  await store.create({id:'project-a',kind:'Project',title:'Project',metadata:{sourceRoot:source}});
  const first = await service.command({command:'selectSection',payload:{section:'Source Code'}});
  assert.ok(first.graph?.nodes.some(node => node.label === 'original'));
  await service.command({command:'selectSection',payload:{section:'Ideas'}});
  await writeFile(file,'def updated(): return 2\n');
  const warm = await service.command({command:'selectSection',payload:{section:'Source Code'}});
  assert.equal(warm.graph,first.graph);
  await service.loadSection({force:true});
  const refreshed = await service.snapshot({cached:true});
  assert.notEqual(refreshed.graph?.revision,first.graph?.revision);
  assert.equal(refreshed.graph?.stale,true);
  assert.ok(refreshed.graph?.nodes.some(node => node.label === 'updated'));
  assert.equal(refreshed.loading,false);
});

test('a pending source load cannot replace another project or section', async t => {
  const {root,store,service} = await fixture(t);
  const source = path.join(root,'source');
  await mkdir(source); await writeFile(path.join(source,'main.py'),'def first(): pass\n');
  await store.create({id:'project-a',kind:'Project',title:'First',metadata:{sourceRoot:source}});
  await store.create({id:'project-b',kind:'Project',title:'Second'});
  await service.snapshot({cached:true});
  const sourceLoad = service.command({command:'selectSection',payload:{section:'Source Code'}});
  const pending = await service.snapshot({cached:true});
  assert.equal(pending.loading,true);
  await service.command({command:'selectProject',payload:{projectId:'project-b'}});
  await service.command({command:'selectSection',payload:{section:'Ideas'}});
  const completed = await sourceLoad;
  assert.equal(completed.selectedProjectId,'project-b');
  assert.equal(completed.section,'Ideas');
  assert.equal(completed.graph,undefined);
  assert.equal(completed.selectedSourceRoot,undefined);
});

test('cached report navigation avoids Git reads until requested and preserves changed files', async t => {
  const {root,store,service} = await fixture(t);
  const repo = path.join(root,'report');
  await mkdir(repo);
  await execute('git',['init'],{cwd:repo});
  await writeFile(path.join(repo,'main.tex'),'First draft\n');
  await store.create({id:'project-a',kind:'Project',title:'Paper',metadata:{report:{path:repo}}});
  const first = await service.command({command:'selectSection',payload:{section:'Report'}});
  assert.equal(first.report.state,'dirty');
  await writeFile(path.join(repo,'new.tex'),'Another section\n');
  await service.command({command:'selectSection',payload:{section:'Overview'}});
  const cached = await service.command({command:'selectSection',payload:{section:'Report'}});
  assert.equal(cached.report,first.report);
  assert.deepEqual(cached.report.changedFiles,['main.tex']);
  await service.loadSection({force:true});
  assert.deepEqual((await service.snapshot({cached:true})).report.changedFiles,['main.tex','new.tex']);
});

test('project-relative actions queued before a project switch reject before invoking integrations', async t => {
  const {root,store} = await fixture(t);
  await store.create({id:'project-a',kind:'Project',title:'First',metadata:{report:{path:path.join(root,'report-a')}}});
  await store.create({id:'project-b',kind:'Project',title:'Second',metadata:{report:{path:path.join(root,'report-b')}}});
  const invoked: string[] = [];
  const service = new ResearchService(store,{
    openSource:async () => { invoked.push('open'); },
    connectDrive:async () => { invoked.push('connect'); return new GoogleDrive({clientId:'test',getTokens:async () => undefined,setTokens:async () => {}}); },
    configureProject:async project => { invoked.push(`configure:${project?.id || 'new'}`); },
  });
  service.report = async push => {
    invoked.push(`${push ? 'push' : 'sync'}:${service.project()?.id}`);
    return {repo:path.join(root,'report-b'),branch:'main',remote:'origin',state:'clean',ahead:0,behind:0,changedFiles:[],lastSyncedAt:undefined};
  };
  await service.command({command:'selectProject',payload:{projectId:'project-b'}});
  for (const command of ['reportPush','reportSync','reportOpen','connectDrive','listDrive','linkDriveFile','configureProject']) {
    await assert.rejects(service.command({command,payload:{contextProjectId:'project-a'}}),/The selected project changed/);
  }
  assert.deepEqual(invoked,[]);
  await service.command({command:'configureProject',payload:{contextProjectId:'project-a',projectId:'project-a'}});
  await service.command({command:'configureProject',payload:{contextProjectId:'project-a',create:true}});
  assert.deepEqual(invoked,['configure:project-a','configure:new']);
});

test('Drive authorization keeps its original project folder when navigation changes during sign-in', async t => {
  const {store} = await fixture(t);
  await store.create({id:'project-a',kind:'Project',title:'First',metadata:{driveFolders:['folder-a']}});
  await store.create({id:'project-b',kind:'Project',title:'Second',metadata:{driveFolders:['folder-b']}});
  const drive = new GoogleDrive({clientId:'test',getTokens:async () => ({accessToken:'test',expiresAt:Date.now()+3600_000}),setTokens:async () => {}});
  const folders: string[] = [];
  drive.listFolder = async id => { folders.push(id); return [{id:'file-a',name:'First project file',mimeType:'text/plain'}]; };
  let authorize!: (value: GoogleDrive) => void;
  const authorization = new Promise<GoogleDrive>(resolve => { authorize = resolve; });
  const service = new ResearchService(store,{openSource:async () => {},connectDrive:() => authorization});
  await service.snapshot({cached:true});
  const connecting = service.command({command:'connectDrive',payload:{contextProjectId:'project-a'}});
  await service.command({command:'selectProject',payload:{projectId:'project-b'}});
  authorize(drive);
  const completed = await connecting;
  assert.deepEqual(folders,['folder-a']);
  assert.equal(completed.selectedProjectId,'project-b');
  assert.deepEqual(completed.files,[]);
  await store.create({id:'note-a',kind:'Note',title:'Not a project'});
  await assert.rejects(service.loadDrive({projectId:'note-a'}),/Choose a research project/);
});
