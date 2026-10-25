import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CodeGraph, GraphEdge, GraphNode } from '../types.js';

const execute = promisify(execFile);
interface SymbolInfo { name: string; qualified: string; line: number; kind: string; description: string }
interface ImportInfo { module: string; name?: string; alias: string; level: number }
interface CallInfo { owner: string; target: string }
interface ParsedFile { path: string; description: string; symbols: SymbolInfo[]; imports: ImportInfo[]; calls: CallInfo[]; error?: string }
const parser = String.raw`
import ast, json, sys
results=[]
for item in json.load(sys.stdin):
    row=dict(path=item['path'], description='', symbols=[], imports=[], calls=[])
    try:
        tree=ast.parse(item['text'], filename=item['path'])
        row['description']=(ast.get_docstring(tree) or '')[:3000]
        class Visitor(ast.NodeVisitor):
            def __init__(self): self.scope=[]
            def symbol(self,node,kind):
                qualified='.'.join(self.scope+[node.name])
                row['symbols'].append(dict(name=node.name,qualified=qualified,line=node.lineno,kind=kind,description=(ast.get_docstring(node) or '')[:2000]))
                self.scope.append(node.name)
                self.generic_visit(node)
                self.scope.pop()
            def visit_FunctionDef(self,node): self.symbol(node,'function')
            def visit_AsyncFunctionDef(self,node): self.symbol(node,'function')
            def visit_ClassDef(self,node): self.symbol(node,'class')
            def visit_Import(self,node):
                for n in node.names: row['imports'].append(dict(module=n.name,alias=n.asname or n.name.split('.')[0],level=0))
            def visit_ImportFrom(self,node):
                for n in node.names: row['imports'].append(dict(module=node.module or '',name=n.name,alias=n.asname or n.name,level=node.level))
            def visit_Call(self,node):
                target=node.func.id if isinstance(node.func,ast.Name) else ''
                if isinstance(node.func,ast.Attribute) and isinstance(node.func.value,ast.Name): target=node.func.value.id+'.'+node.func.attr
                if target: row['calls'].append(dict(owner='.'.join(self.scope),target=target))
                self.generic_visit(node)
        Visitor().visit(tree)
    except SyntaxError as e: row['error']='Syntax error at line '+str(e.lineno)
    results.append(row)
json.dump(results,sys.stdout)
`;

async function parsePython(files: { path: string; text: string }[]): Promise<ParsedFile[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-I', '-c', parser], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Python source analysis timed out.')); }, 20_000);
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; if (output.length > 20_000_000) child.kill(); });
    child.stderr.setEncoding('utf8').on('data', chunk => { error += chunk; });
    child.on('error', e => { clearTimeout(timer); reject(new Error(`Python 3 is needed to inspect source: ${e.message}`)); });
    child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Source analysis failed: ${error.slice(0, 500)}`));
      try { resolve(JSON.parse(output)); } catch { reject(new Error('Python returned invalid source analysis.')); }
    });
    child.stdin.end(JSON.stringify(files));
  });
}

async function discover(root: string): Promise<string[]> {
  try {
    const result = await execute('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: 10_000_000, timeout: 10_000 });
    return [...new Set(result.stdout.split('\0').filter(file => /\.(py|sh)$/.test(file)))].sort();
  } catch {
    const files: string[] = [];
    const ignore = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'results', 'logs', 'data', 'datasets', 'checkpoints']);
    async function walk(directory: string, depth: number) {
      if (depth > 8 || files.length > 1000) return;
      for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
        if (entry.isSymbolicLink() || ignore.has(entry.name)) continue;
        const relative = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(relative, depth + 1);
        else if (/\.(py|sh)$/.test(entry.name)) files.push(relative);
      }
    }
    await walk('', 0);
    return files.sort();
  }
}

function moduleName(file: string): string { return file.replace(/\.py$/, '').replace(/\/__init__$/, '').replaceAll('/', '.'); }
function importFile(info: ImportInfo, owner: string, modules: Map<string, string>): string | undefined {
  const parents = owner.replace(/\/[^/]+$/, '').split('/');
  const prefix = info.level ? parents.slice(0, Math.max(0, parents.length - info.level + 1)).join('.') : '';
  const name = [prefix, info.module].filter(Boolean).join('.');
  return modules.get([name, info.name].filter(Boolean).join('.')) ?? modules.get(name);
}

function moduleGraph(parsed: ParsedFile[], shellFiles: { path: string; text: string }[], root: string, revision: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [{ id: 'source-root', label: path.basename(root), subtitle: 'Source modules', kind: 'method', description: 'Local Python imports and literal shell entrypoints. Dynamic calls are not inferred.' }];
  const edges: GraphEdge[] = [];
  const modules = new Map(parsed.map(file => [moduleName(file.path), file.path]));
  for (const file of parsed) {
    const declarations = file.symbols.map(symbol => `${symbol.qualified} · line ${symbol.line}`).join('\n');
    nodes.push({ id: file.path, label: file.path, subtitle: `${file.symbols.length} symbols`, kind: 'code', status: file.error ? 'Needs review' : undefined,
      source: { path: path.join(root, file.path), line: 1, revision },
      description: [file.error, file.description, declarations].filter(Boolean).join('\n\n') });
    for (const dependency of file.imports) {
      const target = importFile(dependency, file.path, modules);
      if (target && target !== file.path && !edges.some(edge => edge.source === file.path && edge.target === target)) {
        edges.push({ id: `${file.path}:${target}`, source: file.path, target, label: 'imports' });
      }
    }
  }
  for (const file of shellFiles) {
    nodes.push({ id: file.path, label: file.path, subtitle: 'Shell entrypoint', kind: 'code', source: { path: path.join(root, file.path), line: 1, revision }, description: file.text.split('\n').filter(line => /^#(?!\!)/.test(line)).slice(0, 12).join('\n') });
    for (const match of file.text.matchAll(/\b(?:python[0-9.]*|sbatch|bash)\s+(?:-[^\s]+\s+)*["']?([\w./-]+\.(?:py|sh))/g)) {
      const candidates = [match[1], path.posix.join(path.posix.dirname(file.path), match[1]), path.relative(root, match[1])];
      const target = candidates.find(candidate => nodes.some(node => node.id === candidate) || shellFiles.some(shell => shell.path === candidate));
      if (target && target !== file.path) edges.push({ id: `${file.path}:${target}`, source: file.path, target, label: 'starts', inferred: true });
    }
  }
  const connected = new Set(edges.map(edge => edge.target));
  for (const node of nodes.slice(1)) if (!connected.has(node.id)) edges.unshift({ id: `root:${node.id}`, source: 'source-root', target: node.id });
  if (edges.every(edge => edge.source !== 'source-root') && nodes[1]) edges.unshift({ id: 'root:first', source: 'source-root', target: nodes[1].id });
  return { nodes, edges };
}


function callGraph(parsed: ParsedFile[], root: string, revision: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [{ id: 'source-root', label: path.basename(root), subtitle: 'Static function calls', kind: 'method', description: 'Direct calls resolved from Python syntax. Runtime dispatch and external libraries are not shown.' }];
  const edges: GraphEdge[] = [];
  const modules = new Map(parsed.map(file => [moduleName(file.path), file.path]));
  for (const file of parsed) for (const symbol of file.symbols) {
    nodes.push({ id: `${file.path}:${symbol.qualified}`, label: symbol.qualified, subtitle: `${file.path}:${symbol.line}`, kind: 'code',
      source: { path: path.join(root, file.path), line: symbol.line, symbol: symbol.qualified, revision }, description: symbol.description || `${symbol.kind} defined in ${file.path}.` });
  }
  const ids = new Set(nodes.map(node => node.id));
  for (const file of parsed) for (const call of file.calls) {
    const owner = `${file.path}:${call.owner}`;
    if (!ids.has(owner)) continue;
    let target = `${file.path}:${call.target}`;
    const scope = call.owner.split('.');
    while (!ids.has(target) && scope.length) { scope.pop(); target = `${file.path}:${[...scope, call.target].join('.')}`; }
    if (!ids.has(target)) {
      const [alias, member] = call.target.split('.');
      const imported = file.imports.find(info => info.alias === alias);
      if (imported) target = `${importFile(imported, file.path, modules)}:${member ?? imported.name ?? ''}`;
    }
    if (ids.has(target) && target !== owner && !edges.some(edge => edge.source === owner && edge.target === target)) {
      edges.push({ id: `${owner}:${target}`, source: owner, target, label: 'calls', inferred: true });
    }
  }
  const targets = new Set(edges.map(edge => edge.target));
  for (const node of nodes.slice(1)) if (!targets.has(node.id)) edges.unshift({ id: `root:${node.id}`, source: 'source-root', target: node.id });
  return { nodes, edges };
}

export async function buildCodeGraph(sourceRoot: string, mode: 'data' | 'modules', options: { previousRevision?: string } = {}): Promise<CodeGraph> {
  const root = await realpath(sourceRoot);
  const files = await discover(root);
  if (files.length > 1000) throw new Error('This source tree has over 1,000 Python and shell files. Select a smaller source root.');
  const content: { path: string; text: string }[] = [];
  for (const file of files) {
    const resolved = await realpath(path.join(root, file)).catch(() => undefined);
    if (!resolved || path.relative(root, resolved).startsWith('..') || path.isAbsolute(path.relative(root, resolved))) continue;
    if ((await stat(resolved)).size > 2_000_000) throw new Error(`Source file is too large to inspect: ${file}`);
    content.push({ path: file, text: await readFile(resolved, 'utf8') });
  }
  const hash = createHash('sha256');
  for (const file of content) hash.update(file.path).update('\0').update(file.text).update('\0');
  const revision = hash.digest('hex');
  const python = await parsePython(content.filter(file => file.path.endsWith('.py')));
  const graph = mode === 'modules' ? moduleGraph(python, content.filter(file => file.path.endsWith('.sh')), root, revision)
    : callGraph(python, root, revision);
  const semanticStale = 'stale' in graph && graph.stale === true;
  return { ...graph, mode, revision, stale: semanticStale || (options.previousRevision !== undefined && options.previousRevision !== revision), generatedAt: new Date().toISOString() };
}
