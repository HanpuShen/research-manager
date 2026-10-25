import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { ResearchStore } from '../src/store.js';
import { ResearchService } from '../src/service.js';
import { GoogleDrive, type DriveTokens } from '../src/integrations/drive.js';

const execute = promisify(execFile);
async function fixture(t: any) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'research-service-'));
  const store = await new ResearchStore(path.join(root, 'memory'), path.join(root, 'cache')).init();
  t.after(async () => { store.close(); await rm(root, {recursive:true,force:true}); });
  return {root,store,service:new ResearchService(store)};
}
const git = async (cwd:string,...args:string[]) => execute('git',['-c','user.name=Test','-c','user.email=test@example.invalid',...args],{cwd});

test('Report snapshots preserve the last successful check through offline and dirty states, then clear recovered errors', async t => {
  const {root,store,service} = await fixture(t);
  const remote = path.join(root,'remote.git'), repo = path.join(root,'report');
  await git(root,'init','--bare',remote); await git(root,'init',repo);
  await git(repo,'symbolic-ref','HEAD','refs/heads/main');
  await writeFile(path.join(repo,'main.tex'),'original\n');
  await git(repo,'add','.'); await git(repo,'commit','-m','initial');
  await git(repo,'remote','add','origin',remote); await git(repo,'push','-u','origin','main');
  await store.create({id:'project-a',kind:'Project',title:'Paper',metadata:{report:{path:repo}}});
  const clean = await service.report(false);
  assert.ok(clean.lastSyncedAt);
  await git(repo,'remote','set-url','origin',path.join(root,'missing.git'));
  await service.report(false);
  const offline = await service.snapshot();
  assert.equal(offline.report.state,'offline'); assert.equal(offline.report.lastSyncedAt,clean.lastSyncedAt);
  assert.ok(offline.errors.some(error=>/Could not fetch/.test(error)));
  await writeFile(path.join(repo,'main.tex'),'unfinished edits\n');
  await service.report(false);
  const dirty = await service.snapshot();
  assert.equal(dirty.report.state,'dirty'); assert.equal(dirty.report.lastSyncedAt,clean.lastSyncedAt);
  await git(repo,'checkout','--','main.tex'); await git(repo,'remote','set-url','origin',remote);
  await service.report(false);
  const recovered = await service.snapshot();
  assert.equal(recovered.report.state,'clean'); assert.deepEqual(recovered.errors,[]);
});

test('Drive partial results respect filters; network failures show cached metadata and successful reload clears errors', async t => {
  const {store,service} = await fixture(t);
  await store.create({id:'project-a',kind:'Project',title:'Project',metadata:{driveFolders:['root']}});
  let phase: 'complete'|'partial'|'offline' = 'complete';
  let tokens: DriveTokens | undefined = {accessToken:'test',expiresAt:Date.now()+3600_000};
  const json=(value:any,status=200)=>new Response(JSON.stringify(value),{status});
  service.drive=new GoogleDrive({clientId:'test',getTokens:async()=>tokens,setTokens:async(value)=>{tokens=value;},fetch:(async(input:any)=>{
    const url=new URL(input.toString());
    if(phase==='offline')throw new Error('offline');
    if(url.pathname.endsWith('/root'))return json({id:'root',name:'Project',mimeType:'application/vnd.google-apps.folder'});
    if(url.searchParams.has('pageToken'))return json({},403);
    return json({...(phase==='partial'?{nextPageToken:'second'}:{}),files:[{id:'slides',name:'Weekly slides',mimeType:'presentation'},{id:'data',name:'Dataset',mimeType:'binary'}]});
  }) as typeof fetch});
  const options={query:'slides',mimeType:'presentation'};
  await service.loadDrive(options); assert.deepEqual(service.files.map(file=>file.id),['slides']);
  phase='partial'; await service.loadDrive(options);
  assert.deepEqual(service.files.map(file=>file.id),['slides']);
  assert.ok((await service.snapshot()).errors.some(error=>/access/.test(error)));
  phase='offline'; await service.loadDrive(options);
  assert.deepEqual(service.files.map(file=>file.id),['slides']);
  assert.ok((await service.snapshot()).errors.some(error=>/cached files/.test(error)));
  phase='complete'; await service.loadDrive(options);
  assert.deepEqual((await service.snapshot()).errors,[]);
  await service.drive.disconnect();
  const disconnected=await service.snapshot();
  assert.equal(disconnected.driveConnected,false); assert.deepEqual(disconnected.files,[]);
});

test('Linking a Drive item without webViewLink preserves local source references', async t => {
  const {store,service} = await fixture(t);
  const note=await store.create({id:'note-a',kind:'Note',title:'Notes',sources:[{path:'/code/train.py',line:4}]});
  service.files=[{id:'file-a',name:'Slides'}];
  const linked=await service.linkDrive('file-a',note.id);
  assert.deepEqual(linked.sources,[{path:'/code/train.py',line:4},{url:'https://drive.google.com/open?id=file-a',label:'Slides'}]);
});

test('Save commands honor the displayed expectedHash even when the entity payload omits contentHash', async t => {
  const {store,service} = await fixture(t);
  const idea=await store.create({id:'idea-a',kind:'Idea',title:'Idea',body:'Old text'});
  await service.snapshot();
  const raw=await readFile(idea.filePath!,'utf8');
  await writeFile(idea.filePath!,raw.replace('Old text','New text'));
  await service.snapshot();
  await assert.rejects(service.command({command:'saveEntity',payload:{entity:{id:idea.id,body:'Stale overwrite'},expectedRevision:idea.revision,expectedHash:idea.contentHash}}),/changed/);
  assert.equal(store.get(idea.id).body,'New text');
});

test('Opening a different sidebar project clears the prior source selection', async t => {
  const {root,store,service} = await fixture(t);
  const source=path.join(root,'source');await mkdir(source);await writeFile(path.join(source,'main.py'),'def main(): pass\n');
  await store.create({id:'project-a',kind:'Project',title:'First',metadata:{sourceRoot:source}});
  await store.create({id:'project-b',kind:'Project',title:'Second'});
  service.projectId='project-a';await service.snapshot();service.selectedSourceRoot=source;
  service.projectId='project-b';const state=await service.snapshot();
  assert.equal(service.selectedSourceRoot,'');assert.equal(state.selectedSourceRoot,undefined);
});
