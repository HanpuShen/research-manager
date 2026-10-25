import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ResearchStore } from '../src/store.js';

async function fixture(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'research-store-'));const store=await new ResearchStore(path.join(dir,'memory'),path.join(dir,'cache')).init();return {dir,store,async close(){store.close();await fs.rm(dir,{recursive:true,force:true});}};}

test('two independent agents cannot overwrite one another and history survives',async()=>{
  const f=await fixture();const other=await new ResearchStore(f.store.root,path.join(f.dir,'cache2')).init();
  try{
    const record=await f.store.create({kind:'Idea',id:'idea-test',title:'Shared research',body:'Original',projectIds:['p-one','p-two']});
    const edit={expectedRevision:record.revision,expectedHash:record.contentHash!};
    const results=await Promise.allSettled([f.store.update(record.id,{body:'Agent A'},edit),other.update(record.id,{body:'Agent B'},edit)]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(results.filter(r=>r.status==='rejected').length,1);
    await f.store.reindex();assert.equal(f.store.get(record.id).revision,2);
    const history=await fs.readdir(path.join(f.store.root,'history',record.id));assert.equal(history.length,1);
    assert.match(await fs.readFile(path.join(f.store.root,'history',record.id,history[0]),'utf8'),/Original/);
  }finally{other.close();await f.close();}
});

test('search and handoff retain source references and distinguish interpretation',async()=>{
  const f=await fixture();try{
    await f.store.create({kind:'Note',id:'n-one',title:'SQL mechanism',body:'The plus-one explanation is untested.',projectIds:['p-one'],metadata:{role:'Interpretation'},sources:[{path:'/source/log.md',line:42}]});
    await f.store.create({kind:'Idea',id:'i-two',title:'Different project',body:'SQL also occurs here.',projectIds:['p-two']});
    assert.equal(f.store.search('SQL','p-one').length,1);
    const handoff=f.store.fullHandoff('p-one');assert.equal(handoff.records[0].sources[0].line,42);assert.equal(handoff.records[0].metadata.role,'Interpretation');
  }finally{await f.close();}
});

test('accepted verdict changes require a human and archive the previous judgment',async()=>{
  const f=await fixture();try{
    let claim=await f.store.create({kind:'Claim',id:'c-one',title:'A candidate claim',body:'Needs evidence'});
    await assert.rejects(f.store.update(claim.id,{status:'Supported'},{expectedRevision:1,expectedHash:claim.contentHash!,actor:'agent'}),/human/);
    claim=await f.store.reviewClaim(claim.id,'Mixed','Works in one tested condition, fails in another.',{expectedRevision:1,expectedHash:claim.contentHash!});
    assert.equal(claim.status,'Mixed');assert.equal(claim.metadata.review.by,'human');
    assert.equal((await fs.readdir(path.join(f.store.root,'history','c-one'))).length,1);
  }finally{await f.close();}
});

test('overlapping index scans cannot restore old content or remove a newly indexed record',async t=>{
  const f=await fixture();
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  let entered!:()=>void;
  const reading=new Promise<void>(resolve=>{entered=resolve;});
  const scans:Promise<void>[]=[];
  try{
    const record=await f.store.create({id:'idea-original',kind:'Idea',title:'Original',body:'Original content'});
    const raw=await fs.readFile(record.filePath!,'utf8');
    const readFile=fs.readFile.bind(fs), readdir=fs.readdir.bind(fs);
    let firstRead=true;
    t.mock.method(fs,'readFile',async(...args:Parameters<typeof fs.readFile>)=>{
      const content=await readFile(...args);
      if(args[0]===record.filePath && firstRead){firstRead=false;entered();await held;}
      return content;
    });
    const older=f.store.reindex();scans.push(older);await reading;
    await fs.writeFile(record.filePath!,raw.replace('Original content','Current content'));
    await fs.writeFile(path.join(f.store.root,'records','idea-new.md'),raw.replace('id: idea-original','id: idea-new').replace('Original content','New record'));
    let newerStarted=false;
    t.mock.method(fs,'readdir',(...args:Parameters<typeof fs.readdir>)=>{newerStarted=true;return readdir(...args);});
    const newer=f.store.reindex();scans.push(newer);
    await new Promise<void>(resolve=>setImmediate(resolve));
    if(newerStarted)await newer.finally(release);
    else release();
    await Promise.all(scans);
    assert.deepEqual(f.store.list().map(entity=>[entity.id,entity.body]),[
      ['idea-new','New record'],['idea-original','Current content'],
    ]);
  }finally{release();await Promise.allSettled(scans);t.mock.restoreAll();await f.close();}
});

test('compact handoff keeps the overview, primary handoff, mainline cards, and active changes only',async()=>{
  const f=await fixture();try{
    await f.store.create({kind:'Claim',id:'c-main',title:'Main claim',body:'## Statement\nA beats B.\n\n## Decision rule\nLong text.',projectIds:['p-one']});
    await f.store.create({kind:'Claim',id:'c-side',title:'Side claim',body:'Side.',projectIds:['p-one']});
    await f.store.create({kind:'Project',id:'p-one',title:'One',body:'## Question\nOverview text.\n\n## Next decision\nPick A.',projectIds:[],metadata:{researchFlow:{version:1,nodeIds:['c-main','c-side','gone'],overviewNodeIds:['c-main','gone'],edges:[]}}});
    await f.store.create({kind:'Note',id:'n-handoff',title:'Handoff',body:'Next: run A.',projectIds:['p-one'],metadata:{role:'Handoff'}});
    await new Promise(r=>setTimeout(r,5));
    const later=await f.store.create({kind:'Experiment',id:'e-new',title:'New run',body:'## Question\nDoes A beat B?\n\n## Setup\n'+'x'.repeat(5000),projectIds:['p-one']});
    const shelved=await f.store.create({kind:'Idea',id:'i-old',title:'Old idea',body:'Later.',projectIds:['p-one']});
    await f.store.setBackBurner(shelved.id,true,'Out of scope',{expectedRevision:shelved.revision,expectedHash:shelved.contentHash!});
    const h=f.store.handoff('p-one');
    assert.deepEqual(h.project!.sections,[{heading:'Question',summary:'Overview text.'},{heading:'Next decision',summary:'Pick A.'}]);
    assert.equal(h.handoff!.body,'Next: run A.');
    assert.deepEqual(h.mainline.map((c)=>[c.id,c.summary]),[['c-main','A beats B.']]);
    assert.deepEqual(h.unresolvedMainline,['gone']);
    assert.deepEqual(h.changedSinceHandoff.map((c)=>[c.id,c.summary]),[[later.id,'Does A beat B?']]);
    assert.equal(h.backBurner,1);
    assert.equal(h.counts.Claim.Open,2);
    assert.ok(JSON.stringify(h).length<3000);
  }finally{await f.close();}
});

test('search keeps relevance order within the project and handoff rejects unknown projects',async()=>{
  const f=await fixture();try{
    await f.store.create({kind:'Project',id:'p-one',title:'One',body:'Intro.',projectIds:[]});
    await f.store.create({kind:'Note',id:'a-mention',title:'Passing note',body:'Mentions DINO once among many other words here.',projectIds:['p-one']});
    await f.store.create({kind:'Paper',id:'z-paper',title:'DINO world model',body:'DINO DINO DINO',status:'To read',projectIds:['p-one']});
    await f.store.create({kind:'Note',id:'b-other',title:'DINO elsewhere',body:'DINO',projectIds:['p-two']});
    assert.deepEqual(f.store.search('DINO','p-one').map(e=>e.id),['z-paper','a-mention']);
    await f.store.create({kind:'Note',id:'c-proposal',title:'Review proposal: Passing note',body:'x',projectIds:['p-one']});
    assert.equal(f.store.search('passing note','p-one')[0].id,'a-mention');
    assert.throws(()=>f.store.handoff('p-missing'),/Unknown project/);
  }finally{await f.close();}
});

test('compact handoff surfaces claims the handoff discusses that are missing from the mainline',async()=>{
  const f=await fixture();try{
    await f.store.create({kind:'Claim',id:'c-old',title:'Old',body:'x',projectIds:['p-one']});
    await f.store.create({kind:'Claim',id:'c-new',title:'New',body:'x',projectIds:['p-one']});
    await f.store.create({kind:'Project',id:'p-one',title:'One',body:'Intro.',projectIds:[],metadata:{researchFlow:{version:1,overviewNodeIds:['c-old'],nodeIds:['c-old'],edges:[]}}});
    await f.store.create({kind:'Note',id:'n-h',title:'Handoff',body:'Next.',projectIds:['p-one'],metadata:{role:'Handoff'},links:[{target:'c-new',relation:'discusses'}]});
    assert.deepEqual(f.store.handoff('p-one').notOnMainline.map(c=>c.id),['c-new']);
  }finally{await f.close();}
});

test('a human review closes the claim\'s open proposals so they leave the review queue',async()=>{
  const f=await fixture();try{
    const claim=await f.store.create({kind:'Claim',id:'c-one',title:'Claim',body:'x',projectIds:['p-one']});
    const proposal=await f.store.proposeVerdict(claim.id,'Supported','Rule met: yes.');
    await assert.rejects(f.store.proposeVerdict(proposal.id,'Supported','x'),/Not a claim/);
    await f.store.reviewClaim(claim.id,'Supported','Agreed.',{expectedRevision:claim.revision,expectedHash:claim.contentHash!});
    const closed=f.store.get(proposal.id);
    assert.deepEqual([closed.status,closed.metadata.reviewedStatus,closed.body],['Reviewed','Supported','Rule met: yes.']);
    await assert.rejects(f.store.update(closed.id,{links:[]},{expectedRevision:closed.revision,expectedHash:closed.contentHash!}),/only the sources of a reviewed one/);
    const artifact=await f.store.create({kind:'Artifact',id:'a-one',title:'Result',status:'Available',projectIds:['p-one']});
    const invalid=await f.store.invalidateArtifact(artifact.id,'Wrong split.',{expectedRevision:artifact.revision,expectedHash:artifact.contentHash!,actor:'human'});
    await assert.rejects(f.store.update(invalid.id,{status:'Available'},{expectedRevision:invalid.revision,expectedHash:invalid.contentHash!}),/Only the researcher can restore invalidated evidence/);
    const second=await f.store.create({kind:'Claim',id:'c-two',title:'Claim two',body:'x',projectIds:['p-one']});
    await f.store.proposeVerdict(second.id,'Mixed','a');await f.store.proposeVerdict(second.id,'Refuted','b');
    await assert.rejects(f.store.update(second.id,{projectIds:['p-ghost']},{expectedRevision:second.revision,expectedHash:second.contentHash!}),/Unknown project: p-ghost/);
  }finally{await f.close();}
});
