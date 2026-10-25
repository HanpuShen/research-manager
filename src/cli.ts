import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { ResearchStore } from './store.js';
import { ResearchService } from './service.js';
import { listRuns, submitRun, refreshRuns, reconcileSubmission } from './runs.js';
import { buildCodeGraph } from './integrations/code-map.js';
import { readReportStatus, syncReport, reportOutline, readReport } from './integrations/report.js';
import type { Entity, EntityKind } from './types.js';
import { backBurnerCategories, card, type BackBurner } from './workflow.js';
import { lint } from './lint.js';
import { claimContext } from './context.js';
import { guides, readGuide } from './guides.js';
import { serveMcp } from './mcp.js';

async function main() {
  const args = process.argv.slice(2);
  function option(name: string) { const i=args.indexOf(name); if(i<0)return undefined;const value=args[i+1];args.splice(i,2);return value; }
  function options(name: string) { const values: string[]=[];for(let v=option(name);v!==undefined;v=option(name))values.push(v);return values; }
  const root = option('--memory') || process.env.RESEARCH_MEMORY_ROOT || path.resolve(__dirname,'../../research-memory');
  const cache = option('--cache');
  const command = args.shift() || 'help';
  if (command === 'help' || command === '--help') {
    process.stdout.write('research [--memory PATH] COMMAND\n\nprojects | list [PROJECT] [--kind K] [--limit N] | get ID | search QUERY [PROJECT] [--limit N] | handoff PROJECT\n  list, search, and handoff return compact cards; add --full for complete records.\nlint PROJECT [--full] | context CLAIM_ID | guide [NAME] | propose CLAIM_ID STATUS REASON\ncreate JSON_FILE | update ID JSON_FILE --revision N --hash HASH\nreview ID STATUS REASON --revision N --hash HASH --human\npapers PROJECT | paper-add PROJECT [NAME_OR_LINK] [--code URL]... [--title T] [--tag T]... [--notes MARKDOWN] [--no-pdf]\npaper-code PAPER_ID [URL...] --reason TEXT --revision N --hash HASH\npaper-pdf ID (FILE | --arxiv) --revision N --hash HASH\ninvalidate ID REASON --revision N --hash HASH\npark ID [REASON] [--category C] [--superseded-by ID] [--human] --revision N --hash HASH | restore ID [--human] --revision N --hash HASH\nprepare SPEC_JSON | submit REQUEST_ID | runs | refresh | reconcile REQUEST_ID\ncode-map SOURCE_ROOT [data|modules] | report REPO [sync]\nreport-status PROJECT | report-sync PROJECT | report-outline PROJECT | report-read PROJECT FILE [--section TITLE] [--offset N] [--limit N]\npapers-import PROJECT [--from-report] [--bib FILE] [--tag T]... [URL...]\nreindex | mcp [--read-only]\n\nUse - instead of a JSON file to read stdin. Mutations return full records with revision and contentHash.\n'); return;
  }
  const store = await new ResearchStore(root,cache).init();
  const service = new ResearchService(store);
  const jsonFile = async (file: string) => JSON.parse(await (file === '-' ? new Promise<string>((resolve,reject) => { let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk => text+=chunk);process.stdin.on('end',()=>resolve(text));process.stdin.on('error',reject); }) : fs.readFile(file,'utf8')));
  const full = args.includes('--full'); if (full) args.splice(args.indexOf('--full'),1);
  const known = (id?: string) => { if (id && !store.list(id).length) throw new Error(`Unknown project: ${id}`); return id; };
  const searchResult = (hits: Entity[], limit: number) => ({ total: hits.length, truncated: hits.length > limit, results: cards(hits.slice(0, limit)) });
  const cards = (records: Entity[]) => full ? records : records.map(card);
  const human = () => { const i=args.indexOf('--human'); if(i<0)return 'agent' as const; args.splice(i,1); return 'human' as const; };
  const edit = () => ({ expectedRevision:Number(option('--revision')),expectedHash:option('--hash') || '',actor:'agent' as const });
  let result: unknown;
  try {
    switch(command) {
      case 'projects': result=cards(store.list(undefined,'Project'));break;
      case 'list': { const kind=option('--kind') as EntityKind|undefined,limit=Number(option('--limit') || Infinity);result=cards(store.list(known(args[0]),kind).slice(0,limit));break; }
      case 'get': result=store.get(args[0]);break;
      case 'lint': result=lint(store.list(),args[0],new Date(),full?Infinity:undefined,paper=>{const file=store.paperPdfPath(paper);return !!file&&existsSync(file);});break;
      case 'propose': result=await store.proposeVerdict(args[0],args[1],args.slice(2).join(' '));break;
      case 'context': result=claimContext(store.list(),args[0]);break;
      case 'guide': if(args[0]){process.stdout.write(await readGuide(args[0]));return;} result=guides;break;
      case 'search': { const limit=Number(option('--limit') || 50);result=searchResult(store.search(args[0],known(args[1]),Infinity),limit);break; }
      case 'handoff': result=full?store.fullHandoff(args[0]):store.handoff(args[0]);break;
      case 'create': result=await store.create(await jsonFile(args[0]));break;
      case 'update': { const e=edit();result=await store.update(args[0],await jsonFile(args[1]),e);break; }
      case 'review': {
        if(!args.includes('--human'))throw new Error('Claim verdicts need human review. Agents should create a proposal Note.');
        args.splice(args.indexOf('--human'),1);const e=edit();result=await store.reviewClaim(args[0],args[1],args[2],e);break;
      }
      case 'invalidate': {const e=edit();result=await store.invalidateArtifact(args[0],args[1],e);break;}
      case 'park': {const e={...edit(),actor:human()},why={category:option('--category') as BackBurner['category'],supersededBy:option('--superseded-by')};result=await store.setBackBurner(args[0],true,args.slice(1).join(' '),e,why);break;}
      case 'restore': {const e={...edit(),actor:human()};result=await store.setBackBurner(args[0],false,'',e);break;}
      case 'papers': result=cards(store.list(known(args[0]),'Paper'));break;
      case 'paper-add': { const code=options('--code'),tags=options('--tag'),title=option('--title'),notes=option('--notes'),noPdf=args.includes('--no-pdf');if(noPdf)args.splice(args.indexOf('--no-pdf'),1);
        result=args[1]?await service.collectPaper({projectId:args[0],paper:args.slice(1).join(' '),codeUrls:code,tags,title,notes,pdf:!noPdf}):await service.addPaper({projectId:args[0],codeUrls:code,tags,title,notes});break; }
      case 'paper-code': { const reason=option('--reason') || '';const e=edit();result=await service.setPaperCode(args[0],args.slice(1),reason,e);break; }
      case 'paper-pdf': {
        const fromArxiv=args.includes('--arxiv');if(fromArxiv)args.splice(args.indexOf('--arxiv'),1);const e=edit();
        result=fromArxiv?await service.fetchPaperPdf(args[0],e):await store.attachPaperPdf(args[0],await fs.readFile(args[1]),path.basename(args[1]),e);break;
      }
      case 'prepare': result=await service.prepare(await jsonFile(args[0]));break;
      case 'submit': result=await submitRun(root,args[0]);break;
      case 'runs': result=await listRuns(root);break;
      case 'refresh': result=await refreshRuns(root);break;
      case 'reconcile': result=await reconcileSubmission(root,args[0]);break;
      case 'code-map': result=await buildCodeGraph(args[0],args[1] === 'modules'?'modules':'data');break;
      case 'report': result=await (args[1] === 'sync'?syncReport:readReportStatus)(args[0]);break;
      case 'report-status': case 'report-sync': case 'report-outline': case 'report-read': {
        const report=store.get(args[0]).metadata.report;if(!report?.path)throw new Error(`Project ${args[0]} has no linked Overleaf clone.`);
        const section=option('--section'),offset=option('--offset'),limit=option('--limit');
        result=command==='report-status'?await readReportStatus(report.path,report.remote||'origin'):command==='report-sync'?await syncReport(report.path,report.remote||'origin'):command==='report-outline'?await reportOutline(report.path):await readReport(report.path,args[1],{section,offset:offset?Number(offset):undefined,limit:limit?Number(limit):undefined});break;
      }
      case 'papers-import': { const fromReport=args.includes('--from-report');if(fromReport)args.splice(args.indexOf('--from-report'),1);const bibFile=option('--bib');result=await service.importPapers({projectId:args[0],fromReport,bibtex:bibFile?await fs.readFile(bibFile,'utf8'):undefined,urls:args.slice(1),tags:options('--tag')},'agent');break; }
      case 'reindex': await store.reindex();result={records:store.list().length,errors:store.errors};break;
      case 'mcp': await serveMcp(store,service,{readOnly:args.includes('--read-only')});return;
      default: throw new Error(`Unknown command: ${command}`);
    }
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  } finally { if(command !== 'mcp')store.close(); }
}

process.stdout.on('error',e=>{if((e as NodeJS.ErrnoException).code==='EPIPE')process.exit(0);throw e;});
main().catch(e=>{process.stderr.write(JSON.stringify({error:e.message,code:e.code || 'ERROR'})+'\n');process.exitCode=1;});
