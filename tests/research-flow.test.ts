import assert from 'node:assert/strict';
import test from 'node:test';
import { researchMap } from '../webview/Graph.js';
import { stageClaims } from '../webview/Overview.js';
import type { Entity } from '../src/types.js';
const record=(id:string,kind:Entity['kind'],projectIds=['p']):Entity=>({id,kind,projectIds,title:id,status:'Open',revision:1,createdAt:'',updatedAt:'',links:[],sources:[],metadata:{},body:''});
test('Authored flow preserves scientific order, excludes retired branches, and does not change evidence records',()=>{
 const p=record('p','Project');p.metadata.researchFlow={version:1,nodeIds:['first','second','experiment'],edges:[{source:'p',target:'first',label:'first question'},{source:'first',target:'second',label:'next question'},{source:'first',target:'experiment',label:'evidence'}]};
 const entities=[record('first','Claim'),record('second','Claim'),record('experiment','Experiment'),record('historical','Claim')];
 const before=structuredClone(entities);
 for(const section of ['Overview','Experiments']){
  const map=researchMap(p,entities,section);
  assert.deepEqual(map.nodes.map(n=>n.id),['p','first','second','experiment']);
  assert.ok(map.edges.some(e=>e.source==='first'&&e.target==='second'&&e.label==='next question'));
 }
 assert.deepEqual(entities,before);
});
test('Missing or cross-project flow records stay visibly missing rather than borrowing unrelated evidence',()=>{
 const p=record('p','Project');p.metadata.researchFlow={version:1,nodeIds:['foreign'],edges:[{source:'p',target:'foreign'}]};
 const map=researchMap(p,[record('foreign','Claim',['other'])],'Overview');
 assert.equal(map.nodes[1].status,'Needs review');assert.equal(map.nodes[1].entityId,undefined);
});
test('Overview can show only scientific stages while Experiments retains evidence detail',()=>{
 const p=record('p','Project');p.metadata.researchFlow={version:1,overviewNodeIds:['first','second'],nodeIds:['first','second','experiment'],edges:[{source:'first',target:'second',label:'Next question'},{source:'first',target:'experiment',label:'Test'}]};
 const entities=[record('first','Claim'),record('second','Claim'),record('experiment','Experiment')];
 assert.deepEqual(researchMap(p,entities,'Overview').nodes.map(n=>n.id),['first','second']);
 assert.equal(researchMap(p,entities,'Overview').edges.length,1);
 assert.deepEqual(researchMap(p,entities,'Experiments').nodes.map(n=>n.id),['p','first','second','experiment']);
});
test('Shelved claims and experiments leave the authored map and the overview argument but stay in the records',()=>{
 const p=record('p','Project');p.metadata.researchFlow={version:1,overviewNodeIds:['first','old'],nodeIds:['first','old','experiment'],edges:[{source:'first',target:'old'},{source:'old',target:'experiment'}]};
 const old=record('old','Claim');old.metadata.backBurner={active:true,reason:'Superseded',category:'superseded',at:'2026-10-20T00:00:00.000Z',by:'human'};
 const entities=[record('first','Claim'),old,record('experiment','Experiment')];
 assert.deepEqual(researchMap(p,entities,'Overview').nodes.map(n=>n.id),['first']);
 assert.deepEqual(researchMap(p,entities,'Experiments').nodes.map(n=>n.id),['p','first','experiment']);
 assert.equal(researchMap(p,entities,'Experiments').edges.length,0);
 assert.deepEqual(stageClaims(p,entities).map(c=>c.id),['first']);
});
