import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ResearchStore } from './store.js';
import { ResearchService } from './service.js';
import { readEntityPreview } from './previews.js';
import { navigationCommands } from './types.js';

async function main(){
  const root=process.env.RESEARCH_MEMORY_ROOT || path.resolve(__dirname,'../../research-memory');
  const store=await new ResearchStore(root).init();
  const service=new ResearchService(store,{openSource:async(source)=>{throw new Error(`Open this link in the VS Code extension: ${source.path || source.url}`);},connectDrive:async()=>{throw new Error('Connect Google Drive from the VS Code extension.');},configureProject:async()=>{throw new Error('Configure projects from the VS Code extension or research CLI.');}});
  let navigationRevision=0;
  const clientSequences=new Map<string,number>();
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self';");
    const url=new URL(req.url || '/','http://127.0.0.1');
    try{
      if(url.pathname==='/api/state'){
        const state=await service.snapshot();
        res.setHeader('Content-Type','application/json');
        res.end(JSON.stringify({...state,navigationRevision,requestId:url.searchParams.get('requestId')}));return;
      }
      if(url.pathname==='/api/command' && req.method==='POST'){
        const origin=req.headers.origin;
        if(origin && new URL(origin).host!==req.headers.host){res.writeHead(403).end();return;}
        let text='';for await(const chunk of req){text+=chunk;if(text.length>72*1024*1024)throw new Error('Request too large');}
        const message=JSON.parse(text);
        if(message.command==='previewEntity'){
          const preview=await readEntityPreview(store,message.payload?.id);
          res.setHeader('Content-Type','application/json');
          res.end(JSON.stringify({type:'entityPreview',entityId:message.payload?.id,token:message.payload?.token,preview}));return;
        }
        const navigation=navigationCommands.has(message.command);
        let stale=false;
        if(navigation && typeof message.clientId==='string' && Number.isSafeInteger(message.sequence)){
          const previous=clientSequences.get(message.clientId) ?? -1;
          stale=message.sequence<=previous;
          if(!stale){
            clientSequences.set(message.clientId,message.sequence);
            if(clientSequences.size>32)clientSequences.delete(clientSequences.keys().next().value!);
          }
        }
        const revision=navigation && !stale?++navigationRevision:undefined;
        if(!stale)await service.command(message);
        const state=await service.snapshot({cached:true});
        res.setHeader('Content-Type','application/json');
        res.end(JSON.stringify({type:'state',state,requestId:message.requestId,navigationRequestId:navigation?message.requestId:undefined,navigationRevision:revision ?? navigationRevision,savedId:['saveEntity','reviewClaim','invalidateArtifact','setBackBurner','addPaper','refreshPaper','uploadPaperPdf','fetchPaperPdf'].includes(message.command)?message.payload?.id || message.payload?.entity?.id || 'new':undefined}));return;
      }
      if(url.pathname==='/webview.js' || url.pathname==='/webview.css'){
        res.setHeader('Content-Type',url.pathname.endsWith('.js')?'application/javascript':'text/css');res.end(await fs.readFile(path.join(__dirname,url.pathname.slice(1))));return;
      }
      if(/^\/fonts\/[A-Za-z0-9_-]+\.(woff2?|ttf)$/.test(url.pathname)){
        const type=url.pathname.endsWith('.woff2')?'font/woff2':url.pathname.endsWith('.woff')?'font/woff':'font/ttf';
        res.setHeader('Content-Type',type);
        res.end(await fs.readFile(path.join(__dirname,url.pathname.slice(1))));return;
      }
      if(url.pathname!=='/'){res.writeHead(404).end();return;}
      res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/webview.css"><title>Research Manager</title></head><body class="vscode-dark"><div id="root"></div><script src="/webview.js"></script></body></html>');
    }catch(e){res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({type:'error',message:(e as Error).message}));}
  });
  const port=Number(process.env.PORT || 4317);
  server.listen(port,'127.0.0.1',()=>process.stdout.write(`Research Manager preview: http://127.0.0.1:${port}\nMemory: ${root}\n`));
  process.on('SIGTERM',()=>server.close(()=>{store.close();process.exit(0);}));
}
main().catch(e=>{process.stderr.write(e.stack+'\n');process.exitCode=1;});
