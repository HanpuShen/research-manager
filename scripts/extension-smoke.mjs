import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = path.resolve(process.env.RESEARCH_SMOKE_EXTENSION_ROOT || root);
const require = createRequire(import.meta.url);
let vscodeTest;
try { vscodeTest = require('@vscode/test-electron'); }
catch {
  const toolRoot = process.env.VSCODE_TEST_ELECTRON_ROOT || '/tmp/research-manager-vscode-test';
  vscodeTest = require(path.join(toolRoot, 'node_modules/@vscode/test-electron'));
}
const version = process.env.VSCODE_TEST_VERSION || '1.124.2';
const output = path.resolve(process.env.RESEARCH_SMOKE_RESULTS || path.join(root, 'test-results/extension-host.json'));
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'research-extension-host-'));
const memory = path.join(fixture, 'memory');
const workspace = path.join(fixture, 'workspace');
await fs.mkdir(path.join(memory, 'records', 'projects'), {recursive: true});
await fs.mkdir(path.join(workspace, '.vscode'), {recursive: true});
await fs.mkdir(path.dirname(output), {recursive: true});
await fs.rm(output, {force: true});
const sourceFile = path.join(workspace, 'example.py');
await fs.writeFile(sourceFile, 'def evaluate(value):\n    result = value + 1\n    return result\n\nprint(evaluate(2))\n');
await fs.writeFile(path.join(memory, 'records/projects/project-smoke.md'), `---
id: project-smoke
kind: Project
title: Extension host smoke
projectIds: [project-smoke]
status: Active
revision: 1
createdAt: "2026-10-02T00:00:00Z"
updatedAt: "2026-10-02T00:00:00Z"
links: []
sources: []
metadata:
  sourceRoot: ${JSON.stringify(workspace)}
  repos:
    - id: source
      name: Fixture source
      path: ${JSON.stringify(workspace)}
---

Disposable project for a real VS Code extension host smoke test.
`);
await fs.writeFile(path.join(workspace, '.vscode/settings.json'), JSON.stringify({
  'research.memoryRoot': memory,
  'research.cacheRoot': path.join(fixture, 'cache'),
  'research.pollSeconds': 300,
  'research.reportSyncMinutes': 60,
  'security.workspace.trust.enabled': false,
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
}, null, 2));
delete process.env.ELECTRON_RUN_AS_NODE;
delete process.env.VSCODE_IPC_HOOK_CLI;
delete process.env.VSCODE_CLI_AUTHORITY;
delete process.env.VSCODE_CLIENT_COMMAND;
delete process.env.VSCODE_AGENT_FOLDER;
try {
  const executable = process.env.VSCODE_TEST_EXECUTABLE || await vscodeTest.downloadAndUnzipVSCode({
    version,
    cachePath: process.env.VSCODE_TEST_CACHE || '/tmp/research-manager-vscode-test/cache',
    timeout: 30000,
    extensionDevelopmentPath: extensionRoot,
  });
  await vscodeTest.runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: extensionRoot,
    extensionTestsPath: path.join(root, 'tests/extension-host.cjs'),
    extensionTestsEnv: {
      RESEARCH_SMOKE_RESULTS: output,
      RESEARCH_SMOKE_SOURCE: sourceFile,
      RESEARCH_SMOKE_MEMORY: memory,
      RESEARCH_MEMORY_ROOT: memory,
    },
    launchArgs: [workspace, '--disable-extensions', '--disable-gpu', '--disable-telemetry',
      '--user-data-dir=' + path.join(fixture, 'user-data'), '--extensions-dir=' + path.join(fixture, 'extensions')],
  });
  console.log('Extension host evidence: ' + output);
} catch (error) {
  let evidence;
  try { evidence = JSON.parse(await fs.readFile(output, 'utf8')); } catch {}
  if (!evidence) await fs.writeFile(output, JSON.stringify({passed: false, stage: 'launch', version, fixture, error: String(error)}, null, 2));
  console.error('Extension host smoke failed; fixture retained at ' + fixture);
  throw error;
}
