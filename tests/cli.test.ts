import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const run=promisify(execFile);
test('bundled CLI and MCP share the same Markdown memory and source references',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'research-cli-'));
  const client=new Client({name:'acceptance-test',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/cli.cjs'),'--memory',dir,'mcp'],stderr:'pipe'});
  try{
    await client.connect(transport);
    const tools=await client.listTools();assert.ok(tools.tools.some(t=>t.name==='research_prepare_run'));
    await client.callTool({name:'research_create',arguments:{record:{kind:'Project',id:'p-test',title:'Test',projectIds:[]}}});
    const created=await client.callTool({name:'research_create',arguments:{record:{kind:'Idea',id:'idea-mcp',title:'MCP round trip',body:'A durable research motivation',projectIds:['p-test'],sources:[{path:'/a/real-source-ref.md'}]}}});
    assert.equal(created.isError,undefined);
    const {stdout}=await run(process.execPath,['dist/cli.cjs','--memory',dir,'get','idea-mcp']);
    const entity=JSON.parse(stdout);assert.equal(entity.sources[0].path,'/a/real-source-ref.md');assert.equal(entity.revision,1);
    const changed=await client.callTool({name:'research_update',arguments:{id:entity.id,expectedRevision:entity.revision,expectedHash:entity.contentHash,patch:{body:'Updated by a second interface'}}});
    assert.equal(changed.isError,undefined);
    const stale=await client.callTool({name:'research_update',arguments:{id:entity.id,expectedRevision:entity.revision,expectedHash:entity.contentHash,patch:{body:'Stale overwrite'}}});
    assert.equal(stale.isError,true);
    assert.match(await fs.readFile(path.join(dir,'records','idea-mcp.md'),'utf8'),/Updated by a second interface/);
  }finally{await client.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('MCP serves guides as tools and prompts, compact queries, lint, and claim context',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'research-cli-'));
  const client=new Client({name:'acceptance-test',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/cli.cjs'),'--memory',dir,'mcp'],stderr:'pipe'});
  const text=(result:any)=>result.content[0].text as string;
  try{
    await client.connect(transport);
    const prompts=await client.listPrompts();
    assert.deepEqual(prompts.prompts.map(p=>p.name).sort(),['agent','back-burner','experiment','ponytail','project-overview','related-work','report-and-files']);
    assert.match(((await client.getPrompt({name:'ponytail'})).messages[0].content as any).text,/name: ponytail/);
    assert.match(text(await client.callTool({name:'research_guide',arguments:{name:'related-work'}})),/## 4\. Links from the Paper/);
    await client.callTool({name:'research_create',arguments:{record:{kind:'Project',id:'p',title:'P',body:'Intro.',projectIds:[]}}});
    await client.callTool({name:'research_create',arguments:{record:{kind:'Claim',id:'c-one',title:'One claim',body:'## Statement\nA beats B.',projectIds:['p']}}});
    await client.callTool({name:'research_create',arguments:{record:{kind:'Experiment',id:'e-one',title:'Does A beat B?',status:'Completed',body:'## Decision rule\nA > B.\n\n## Result\nRule met: yes — 3 vs 2.',projectIds:['p'],links:[{target:'c-one',relation:'tests'}]}}});
    const cards=JSON.parse(text(await client.callTool({name:'research_search',arguments:{projectId:'p'}}))).results;
    assert.deepEqual(Object.keys(cards.find((c:any)=>c.id==='c-one')).sort(),['id','kind','placement','status','summary','title','updatedAt']);
    const linted=JSON.parse(text(await client.callTool({name:'research_lint',arguments:{projectId:'p'}})));
    assert.deepEqual(linted.readyForVerdict.map((v:any)=>[v.id,v.proposed]),[['c-one','Supported']]);
    const context=JSON.parse(text(await client.callTool({name:'research_context',arguments:{claimId:'c-one'}})));
    assert.equal(context.experiments[0].decisionRule,'A > B.');
    assert.match(text(await client.callTool({name:'research_guide',arguments:{}})),/"related-work"/);
    const found=JSON.parse(text(await client.callTool({name:'research_search',arguments:{projectId:'p',query:'beat',limit:1}})));
    assert.deepEqual([found.total,found.truncated,found.results.length],[2,true,1]);
    const {stdout}=await run(process.execPath,['dist/cli.cjs','--memory',dir,'search','beat','p','--limit','5']);
    assert.deepEqual(JSON.parse(stdout).truncated,false);
    const unknown=await client.callTool({name:'research_search',arguments:{projectId:'p-nope'}});
    assert.equal(unknown.isError,true);assert.match(text(unknown),/research_search \{"kind": "Project"\}/);
    assert.deepEqual(JSON.parse((await run(process.execPath,['dist/cli.cjs','--memory',dir,'list','p','--kind','Claim','--limit','1'])).stdout).map((c:any)=>c.id),['c-one']);
    await client.callTool({name:'research_propose_verdict',arguments:{claimId:'c-one',status:'Supported',reason:'Rule met: yes.'}});
    const after=JSON.parse(text(await client.callTool({name:'research_lint',arguments:{projectId:'p'}})));
    assert.deepEqual([after.readyForVerdict.length,after.awaitingReview.map((a:any)=>[a.id,a.proposed])],[0,[['c-one','Supported']]]);
  }finally{await client.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('MCP tools are described, annotated, compact, and read-only mode registers no write tools',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'research-cli-'));
  const connect=async(extra:string[])=>{const client=new Client({name:'acceptance-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/cli.cjs'),'--memory',dir,'mcp',...extra],stderr:'pipe'}));return client;};
  const text=(result:any)=>result.content[0].text as string;
  const client=await connect([]),readOnly=await connect(['--read-only']);
  try{
    assert.match(client.getInstructions() ?? '',/Start a session with research_handoff/);
    const {tools}=await client.listTools();
    assert.deepEqual(tools.flatMap(t=>Object.entries((t.inputSchema as any).properties ?? {}).filter(([,p]:any)=>!p.description).map(([k])=>`${t.name}.${k}`)),[]);
    assert.ok(tools.every(t=>t.title&&t.annotations&&typeof t.annotations.readOnlyHint==='boolean'));
    const readNames=(await readOnly.listTools()).tools.map(t=>t.name).sort();
    assert.deepEqual(readNames,tools.filter(t=>t.annotations!.readOnlyHint).map(t=>t.name).sort());
    assert.ok(!readNames.includes('research_update')&&readNames.includes('research_handoff'));
    const orphan=await client.callTool({name:'research_create',arguments:{record:{kind:'Idea',title:'Orphan',projectIds:['p']}}});
    assert.match(text(orphan),/Unknown project: p\. Create the Project record first/);
    await client.callTool({name:'research_create',arguments:{record:{kind:'Project',id:'p',title:'P',projectIds:[]}}});
    const badStatus=await client.callTool({name:'research_create',arguments:{record:{kind:'Experiment',title:'E',status:'Finished',projectIds:['p']}}});
    assert.match(text(badStatus),/Status "Finished" is not allowed for Experiment/);
    const claim=JSON.parse(text(await client.callTool({name:'research_create',arguments:{record:{kind:'Claim',title:'C',projectIds:['p']}}})));
    const proposal=JSON.parse(text(await client.callTool({name:'research_propose_verdict',arguments:{claimId:claim.id,status:'Mixed',reason:'2 of 4 tasks.'}})));
    const selfReview=await client.callTool({name:'research_update',arguments:{id:proposal.id,patch:{status:'Reviewed',metadata:{reviewedStatus:'Mixed'}},expectedRevision:proposal.revision,expectedHash:proposal.contentHash}});
    assert.equal(selfReview.isError,true);assert.match(text(selfReview),/Only the researcher closes a verdict proposal/);
    for(const patch of [{links:[]},{metadata:{proposedStatus:'Supported'}},{metadata:{role:'Observation'}}]){
      const hidden=await client.callTool({name:'research_update',arguments:{id:proposal.id,patch,expectedRevision:proposal.revision,expectedHash:proposal.contentHash}});
      assert.equal(hidden.isError,true,JSON.stringify(patch));
    }
    const reworded=await client.callTool({name:'research_update',arguments:{id:proposal.id,patch:{body:'2 of 4 tasks; see Table 2.'},expectedRevision:proposal.revision,expectedHash:proposal.contentHash}});
    assert.equal(reworded.isError,undefined);
    const shelveProposed=await client.callTool({name:'research_set_back_burner',arguments:{id:claim.id,active:true,reason:'x',expectedRevision:claim.revision,expectedHash:claim.contentHash}});
    assert.match(text(shelveProposed),/open verdict proposal/);
    const extra=await client.callTool({name:'research_update',arguments:{id:claim.id,patch:{projectIds:[]},expectedRevision:claim.revision,expectedHash:claim.contentHash}});
    assert.equal(extra.isError,true);
    for(const record of [{kind:'Note',title:'Fake review',status:'Reviewed',projectIds:['p']},{kind:'Note',title:'Fake',metadata:{reviewedStatus:'Supported'},projectIds:['p']},{kind:'Artifact',title:'Bad',status:'Invalid',projectIds:['p']},{kind:'Claim',title:'Pre-judged',status:'Supported',projectIds:['p']}]){
      const forged=await client.callTool({name:'research_create',arguments:{record}});
      assert.equal(forged.isError,true,record.title);
    }
    const missing=await client.callTool({name:'research_context',arguments:{claimId:'claim-nope'}});
    assert.match(text(missing),/Record not found: claim-nope\. Find the right id with research_search/);
    const created=JSON.parse(text(await client.callTool({name:'research_create',arguments:{record:{kind:'Idea',title:'Brief result',body:'x'.repeat(5000),projectIds:['p']}}})));
    assert.equal(created.body,undefined);assert.equal(created.revision,1);assert.ok(created.contentHash);
    assert.ok(!text(await client.callTool({name:'research_get',arguments:{id:created.id}})).includes('\n  '));
    const stale=await client.callTool({name:'research_update',arguments:{id:created.id,patch:{body:'y'},expectedRevision:9,expectedHash:'old'}});
    assert.equal(stale.isError,true);assert.match(text(stale),/Call research_get for this id/);
    const page=JSON.parse(text(await client.callTool({name:'research_search',arguments:{projectId:'p',kind:'Idea',limit:1,offset:0}})));
    assert.deepEqual([page.total,page.offset,page.truncated],[1,0,false]);
    assert.match(readOnly.getInstructions() ?? '',/read-only connection/);
    const prompt=await fs.readFile('docs/guides/agent-prompt.md','utf8');
    assert.deepEqual(tools.map(t=>t.name).filter(name=>!prompt.includes(name)),[]);
    const noReport=await client.callTool({name:'research_report_outline',arguments:{projectId:'p'}});
    assert.match(text(noReport),/no linked Overleaf clone/);
    const idea=JSON.parse(text(await client.callTool({name:'research_get',arguments:{id:created.id}})));
    const shelve={id:idea.id,active:true,reason:'Later',category:'deprioritized',expectedRevision:idea.revision,expectedHash:idea.contentHash};
    const first=JSON.parse(text(await client.callTool({name:'research_set_back_burner',arguments:shelve})));
    const replay=await client.callTool({name:'research_set_back_burner',arguments:shelve});
    assert.equal(replay.isError,undefined);assert.equal(JSON.parse(text(replay)).revision,first.revision);
    await client.callTool({name:'research_update',arguments:{id:idea.id,patch:{sources:[{path:'/data/run.csv'}]},expectedRevision:first.revision,expectedHash:first.contentHash}});
    const withPath=JSON.parse(text(await client.callTool({name:'research_get',arguments:{id:idea.id}})));
    await client.callTool({name:'research_update',arguments:{id:idea.id,patch:{addSources:[{url:'https://drive.google.com/file/d/abc/view',label:'Sweep sheet'}]},expectedRevision:withPath.revision,expectedHash:withPath.contentHash}});
    assert.deepEqual(JSON.parse(text(await client.callTool({name:'research_get',arguments:{id:idea.id}}))).sources.map((s:any)=>s.path??s.url),['/data/run.csv','https://drive.google.com/file/d/abc/view']);
    const linked=JSON.parse(text(await client.callTool({name:'research_linked_files',arguments:{projectId:'p',query:'sweep'}})));
    assert.deepEqual(linked.files.map((f:any)=>[f.kind,f.label,f.records[0].id]),[['drive','Sweep sheet',idea.id]]);
  }finally{await client.close();await readOnly.close();await fs.rm(dir,{recursive:true,force:true});}
});
