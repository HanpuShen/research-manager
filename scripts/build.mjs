import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
for (const entry of ['extension','cli','preview']) {
  await build({ entryPoints:[`src/${entry}.ts`],bundle:true,platform:'node',target:'node24',format:'cjs',outfile:`dist/${entry}.cjs`,external:['vscode'],sourcemap:true,logLevel:'info' });
}
await build({entryPoints:['webview/main.tsx'],bundle:true,platform:'browser',target:'es2022',format:'iife',outfile:'dist/webview.js',sourcemap:true,minify:true,define:{'process.env.NODE_ENV':'"production"'},loader:{'.css':'css','.woff2':'file','.woff':'file','.ttf':'file'},assetNames:'fonts/[name]-[hash]',logLevel:'info'});
await copyFile('node_modules/katex/LICENSE', 'dist/katex-LICENSE.txt');
