import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { ResearchStore } from './store.js';
import { ResearchService } from './service.js';
import { readEntityPreview } from './previews.js';
import { GoogleDrive, createAuthSession, type DriveTokens } from './integrations/drive.js';
import { navigationCommands, type BridgeMessage, type Entity, type Section, type SourceRef } from './types.js';

const sections: Section[] = ['Overview','Ideas','Experiments','Related work','Source Code','Report','Files'];
class ResearchTree implements vscode.TreeDataProvider<vscode.TreeItem> {
  private changes = new vscode.EventEmitter<void>();
  onDidChangeTreeData = this.changes.event;
  constructor(private readonly service: ResearchService) {}
  refresh() { this.changes.fire(); }
  getTreeItem(item: vscode.TreeItem) { return item; }
  getChildren(item?: vscode.TreeItem) {
    if (!item) return this.service.store.list(undefined,'Project').map(p => {
      const node = new vscode.TreeItem(p.title,vscode.TreeItemCollapsibleState.Expanded);
      node.id=p.id;node.contextValue='project';node.iconPath=new vscode.ThemeIcon('beaker');return node;
    });
    return sections.map(section=>{
      const node=new vscode.TreeItem(section);node.id=`${item.id}/${section}`;
      node.command={command:'research.open',title:section,arguments:[item.id,section]};
      node.iconPath=new vscode.ThemeIcon(({Overview:'type-hierarchy',Ideas:'lightbulb',Experiments:'beaker','Related work':'library','Source Code':'symbol-method',Report:'book',Files:'folder'} as const)[section]);
      return node;
    });
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const config=vscode.workspace.getConfiguration('research');
  const memoryRoot=config.get<string>('memoryRoot') || process.env.RESEARCH_MEMORY_ROOT || path.join(os.homedir(),'Project','research-memory');
  const store=await new ResearchStore(memoryRoot,config.get<string>('cacheRoot') || undefined).init();
  await fs.writeFile(path.join(store.cacheRoot,'activation.json'),JSON.stringify({extensionVersion:context.extension.packageJSON.version,activatedAt:new Date().toISOString(),remoteName:vscode.env.remoteName || null,nodeVersion:process.version,mode:context.extensionMode},null,2));
  let panel:vscode.WebviewPanel|undefined;
  let queue:Promise<unknown>=Promise.resolve();
  const service=new ResearchService(store,{
    openSource:async(source:SourceRef)=>{
      if(source.url){const uri=vscode.Uri.parse(source.url);if(!['https','http'].includes(uri.scheme))throw new Error('Only web links are supported.');await vscode.env.openExternal(uri);return;}
      if(!source.path)throw new Error('This node has no source file.');
      if(/\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(source.path)){
        await vscode.commands.executeCommand('vscode.open',vscode.Uri.file(source.path),{viewColumn:vscode.ViewColumn.Beside,preview:true});return;
      }
      const doc=await vscode.workspace.openTextDocument(vscode.Uri.file(source.path));
      const editor=await vscode.window.showTextDocument(doc,{viewColumn:vscode.ViewColumn.Beside,preview:true,preserveFocus:false});
      const line=Math.max(0,Math.min(doc.lineCount-1,(source.line || 1)-1));
      editor.selection=new vscode.Selection(line,0,line,0);editor.revealRange(new vscode.Range(line,0,line,0),vscode.TextEditorRevealType.InCenter);
    },
    connectDrive:()=>connectDrive(context),
    configureProject:async(project?:Entity)=>{
      if(!project){
        const title=await vscode.window.showInputBox({title:'New research project',prompt:'Paper or research deliverable title'});
        if(!title)return;
        project=await store.create({kind:'Project',title,status:'Active',body:'Describe the research goal and current questions.',metadata:{repos:[],driveFolders:[]}},'human');
      }
      const setting=await vscode.window.showQuickPick(['Source folder','Overleaf clone','Drive folder','Project notes'],{title:project.title});
      if(!setting)return;
      if(setting==='Project notes'){await vscode.commands.executeCommand('vscode.open',vscode.Uri.file(project.filePath!));return;}
      const current=setting==='Source folder'?project.metadata.sourceRoot:setting==='Overleaf clone'?project.metadata.report?.path:project.metadata.driveFolders?.[0]?.id;
      const value=await vscode.window.showInputBox({title:setting,value:current || '',prompt:setting==='Drive folder'?'Paste a Drive folder URL or folder ID':'Absolute folder path on this cluster'});
      if(value===undefined || !value.trim())return;
      const metadata={...project.metadata};
      if(setting==='Drive folder'){
        const id=value.match(/folders\/([\w-]+)/)?.[1] || value.trim();
        if(!/^[\w-]+$/.test(id))throw new Error('Enter a Drive folder ID or folder URL.');
        metadata.driveFolders=[{id,name:'Project files'}];service.files=[];
      }else{
        const folder=path.resolve(value);const stat=await fs.stat(folder);if(!stat.isDirectory())throw new Error('Choose a directory.');
        if(setting==='Source folder'){metadata.sourceRoot=folder;metadata.repos=[...(metadata.repos || []).filter((r:any)=>r.path!==folder),{id:path.basename(folder),name:path.basename(folder),path:folder}];}
        else metadata.report={path:folder,remote:'origin',mainFile:'main.tex'};
      }
      await store.update(project.id,{metadata},{expectedRevision:project.revision,expectedHash:project.contentHash!,actor:'human'});
    }
  });
  const existingClient=config.get<string>('googleClientId');
  if(existingClient && await context.secrets.get('research.drive.tokens'))service.drive=await driveClient(context,existingClient);
  const tree=new ResearchTree(service);
  context.subscriptions.push(vscode.window.registerTreeDataProvider('research.projects',tree));
  const output=vscode.window.createOutputChannel('Research Manager');context.subscriptions.push(output);
  let navigationRevision=0;
  let disposed=false;
  let refreshing:Promise<unknown>|undefined, syncing:Promise<unknown>|undefined;
  const send=async(meta:Record<string,unknown>={})=>{
    const revision=navigationRevision;
    const state=await service.snapshot({cached:true});
    if(!disposed){tree.refresh();await panel?.webview.postMessage({type:'state',state,navigationRevision:revision,...meta});}
    return state;
  };
  const fail=async(error:unknown,meta:Record<string,unknown>={})=>{
    if(disposed)return;
    output.appendLine((error as Error).message);
    await panel?.webview.postMessage({type:'error',message:(error as Error).message,...meta});
  };
  const enqueue=(fn:()=>Promise<unknown>)=>{
    const task=queue.then(fn);
    queue=task.catch(()=>{});
    return task;
  };
  const refresh=()=>{
    if(!refreshing)refreshing=(async()=>{await service.refresh();return send();})().finally(()=>{refreshing=undefined;});
    return refreshing;
  };
  const syncReports=()=>{
    if(!syncing)syncing=(async()=>{await service.syncReports();return send();})().finally(()=>{syncing=undefined;});
    return syncing;
  };
  const dispatch=async(message:BridgeMessage)=>{
    if(!vscode.workspace.isTrusted && !['ready','selectProject','selectSection','selectSource','codeMode','openSource','openEntity','previewEntity'].includes(message.command))throw new Error('Trust this workspace before changing research records or connecting services.');
    message={...message,payload:{contextProjectId:service.project()?.id || '',...message.payload}};
    const meta={requestId:message.requestId};
    if(message.command==='ready')return send(meta);
    if(message.command==='previewEntity'){
      const reply={type:'entityPreview',entityId:message.payload?.id,token:message.payload?.token};
      try{
        const preview=await readEntityPreview(store,message.payload?.id);
        if(!disposed)await panel?.webview.postMessage({...reply,preview});
        return preview;
      }catch(error){
        if(!disposed)await panel?.webview.postMessage({...reply,error:(error as Error).message});
        return undefined;
      }
    }
    if(navigationCommands.has(message.command)){
      const revision=++navigationRevision;
      const navigationMeta={...meta,navigationRequestId:message.requestId,navigationRevision:revision};
      const task=service.command(message).then(()=>({error:undefined as unknown}),error=>({error}));
      await send(navigationMeta);
      const result=await task;
      if(result.error && revision===navigationRevision)throw result.error;
      return revision===navigationRevision?send(navigationMeta):service.snapshot({cached:true});
    }
    if(message.command==='refresh'){await refresh();return send(meta);}
    const action=async()=>{
      await service.command(message);
      const state=await send(meta);
      if(['saveEntity','reviewClaim','invalidateArtifact','setBackBurner','addPaper','refreshPaper','uploadPaperPdf','fetchPaperPdf'].includes(message.command))await panel?.webview.postMessage({type:'saved',id:message.payload?.id || message.payload?.entity?.id});
      return state;
    };
    return ['openSource','openEntity'].includes(message.command)?action():enqueue(action);
  };
  const open=async(projectId?:string,section?:Section)=>{
    if(projectId)service.projectId=projectId;if(section)service.section=section;
    const revision=++navigationRevision;
    if(panel)panel.reveal(vscode.ViewColumn.One);
    else{
      panel=vscode.window.createWebviewPanel('research.manager','Research Manager',vscode.ViewColumn.One,{enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,'dist')]});
      panel.webview.html=webviewHtml(panel.webview,context.extensionUri);
      panel.onDidDispose(()=>panel=undefined,undefined,context.subscriptions);
      panel.webview.onDidReceiveMessage(message=>{void dispatch(message).catch(error=>fail(error,{requestId:message.requestId}));},undefined,context.subscriptions);
    }
    await send({externalNavigation:true,navigationRevision:revision});
    void service.loadSection().then(()=>{if(revision===navigationRevision)return send();}).catch(error=>fail(error));
  };
  context.subscriptions.push(vscode.commands.registerCommand('research.open',open));
  context.subscriptions.push(vscode.window.registerUriHandler({handleUri:async(uri)=>{if(uri.path==='/open')await open();}}));
  context.subscriptions.push(vscode.commands.registerCommand('research.refresh',()=>refresh().catch(error=>fail(error))));
  context.subscriptions.push(vscode.commands.registerCommand('research.configure',async()=>{
    const value=await vscode.window.showInputBox({title:'Shared research memory',value:store.root,prompt:'Absolute path on this cluster'});
    if(value){await config.update('memoryRoot',value,vscode.ConfigurationTarget.Global);await vscode.commands.executeCommand('workbench.action.reloadWindow');}
  }));
  const poll=setInterval(()=>{void refresh().catch(error=>fail(error));},Math.max(10,config.get<number>('pollSeconds',30))*1000);
  const reports=setInterval(()=>{if(vscode.workspace.isTrusted)void syncReports().catch(error=>fail(error));},Math.max(1,config.get<number>('reportSyncMinutes',5))*60000);
  context.subscriptions.push({dispose:()=>{disposed=true;clearInterval(poll);clearInterval(reports);void Promise.allSettled([refreshing,syncing,queue]).then(()=>store.close());}});
  void service.snapshot().then(()=>send()).catch(error=>fail(error));
  if(vscode.workspace.isTrusted){void refresh().catch(error=>fail(error));void syncReports().catch(error=>fail(error));}
  if(context.extensionMode===vscode.ExtensionMode.Test)return {snapshot:()=>service.snapshot(),command:dispatch,treeChildren:(item?:vscode.TreeItem)=>tree.getChildren(item),enqueue};

}

async function driveClient(context:vscode.ExtensionContext,clientId:string) {
  const clientSecret=await context.secrets.get('research.drive.clientSecret');
  return new GoogleDrive({clientId,clientSecret,getTokens:async()=>{const raw=await context.secrets.get('research.drive.tokens');return raw?JSON.parse(raw) as DriveTokens:undefined;},setTokens:async(tokens)=>{if(tokens)await context.secrets.store('research.drive.tokens',JSON.stringify(tokens));else await context.secrets.delete('research.drive.tokens');}});
}

async function connectDrive(context:vscode.ExtensionContext) {
  const config=vscode.workspace.getConfiguration('research');
  let clientId=config.get<string>('googleClientId');
  if(!clientId){
    clientId=await vscode.window.showInputBox({title:'Connect Google Drive',prompt:'Google Desktop OAuth client ID (enable the Drive API in your Google Cloud project)'});
    if(!clientId)throw new Error('Drive connection cancelled.');
    await config.update('googleClientId',clientId,vscode.ConfigurationTarget.Global);
  }
  if(!await context.secrets.get('research.drive.clientSecret')){
    const secret=await vscode.window.showInputBox({title:'Google Desktop OAuth client',prompt:'Client secret from your downloaded Desktop OAuth credentials (leave blank if not required)',password:true});
    if(secret===undefined)throw new Error('Drive connection cancelled.');
    if(secret)await context.secrets.store('research.drive.clientSecret',secret);
  }
  const client=await driveClient(context,clientId);
  const server=http.createServer();
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address() as {port:number};
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try{
    const callback=await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${address.port}/oauth/callback`));
    const session=createAuthSession(clientId,callback.toString(true));
    await new Promise<void>((resolve,reject)=>{
      timeout=setTimeout(()=>reject(new Error('Drive sign-in timed out. Select Connect Drive to try again.')),180000);
      server.on('request',async(req,res)=>{
        const url=new URL(req.url || '/',callback.toString());
        if(url.pathname!=='/oauth/callback'){res.writeHead(404).end();return;}
        try{
          if(url.searchParams.get('error'))throw new Error(`Google sign-in: ${url.searchParams.get('error')}`);
          await client.exchangeCode(session,url.searchParams.get('code') || '',url.searchParams.get('state') || '');
          res.writeHead(200,{'Content-Type':'text/plain'}).end('Google Drive connected. Return to VS Code.');resolve();
        }catch(e){res.writeHead(400,{'Content-Type':'text/plain'}).end('Could not complete sign-in. Return to VS Code for details.');reject(e);}
      });
      void vscode.env.openExternal(vscode.Uri.parse(session.url)).then(opened=>{if(!opened)reject(new Error('Could not open the sign-in page.'));},reject);
    });
    return client;
  }finally{if(timeout)clearTimeout(timeout);server.close();}
}

function webviewHtml(webview:vscode.Webview,extensionUri:vscode.Uri) {
  const script=webview.asWebviewUri(vscode.Uri.joinPath(extensionUri,'dist','webview.js'));
  const style=webview.asWebviewUri(vscode.Uri.joinPath(extensionUri,'dist','webview.css'));
  const nonce=randomBytes(20).toString('hex');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src ${webview.cspSource} 'unsafe-inline';script-src 'nonce-${nonce}';img-src ${webview.cspSource} data:;font-src ${webview.cspSource};"><link rel="stylesheet" href="${style}"><title>Research Manager</title></head><body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
}
