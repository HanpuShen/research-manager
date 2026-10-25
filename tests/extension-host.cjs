const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async function run() {
  const report = {passed: false, host: 'VS Code extension host', remoteName: vscode.env.remoteName || null,
    vscodeVersion: vscode.version, nodeVersion: process.version, platform: process.platform, checks: []};
  const resultPath = process.env.RESEARCH_SMOKE_RESULTS;
  async function check(name, action) { await action(); report.checks.push({name, passed: true}); }
  try {
    const extension = vscode.extensions.getExtension('hanpu.research-manager');
    assert.ok(extension, 'The development extension must be discovered');
    report.extensionPath = extension.extensionPath;
    let api;
    await check('Activate the built extension in a real host', async () => {
      api = await extension.activate();
      assert.equal(extension.isActive, true);
      assert.ok(api?.snapshot && api?.command && api?.treeChildren, 'Expose the smoke API only in ExtensionMode.Test');
    });
    await check('Register sidebar commands and list the fixture project', async () => {
      const commands = await vscode.commands.getCommands(true);
      for (const name of ['research.open', 'research.refresh', 'research.configure']) assert.ok(commands.includes(name), name);
      const roots = await api.treeChildren();
      assert.equal(roots.length, 1);
      assert.equal(roots[0].id, 'project-smoke');
      const children = await api.treeChildren(roots[0]);
      assert.deepEqual(children.map(item => item.label), ['Overview', 'Ideas', 'Experiments', 'Source Code', 'Report', 'Files']);
      assert.ok(children.every(item => item.command.command === 'research.open'));
      await vscode.commands.executeCommand('research.projects.focus');
    });
    await check('Open the research editor and refresh shared memory', async () => {
      await vscode.commands.executeCommand('research.open', 'project-smoke', 'Overview');
      await vscode.commands.executeCommand('research.refresh');
      const state = await api.snapshot();
      assert.equal(state.selectedProjectId, 'project-smoke');
      assert.equal(path.resolve(state.memoryRoot), path.resolve(process.env.RESEARCH_SMOKE_MEMORY));
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);
      assert.ok(tabs.some(tab => tab.label === 'Research Manager'), 'Research Manager must be a real editor tab');
    });
    await check('Use the extension source link to select the correct file and line', async () => {
      await api.command({command: 'openSource', payload: {source: {path: process.env.RESEARCH_SMOKE_SOURCE, line: 3}}});
      const editor = vscode.window.activeTextEditor;
      assert.ok(editor);
      assert.equal(path.resolve(editor.document.uri.fsPath), path.resolve(process.env.RESEARCH_SMOKE_SOURCE));
      assert.equal(editor.selection.active.line, 2);
      assert.equal(editor.viewColumn, vscode.ViewColumn.Two);
    });
    await check('Open the canonical Markdown record from its entity', async () => {
      await api.command({command: 'openEntity', payload: {id: 'project-smoke'}});
      assert.match(vscode.window.activeTextEditor.document.uri.fsPath, /project-smoke\.md$/);
    });
    await check('Explicit refresh observes a Markdown edit without relying on file watchers', async () => {
      const file = vscode.window.activeTextEditor.document.uri.fsPath;
      const raw = await fs.readFile(file, 'utf8');
      await fs.writeFile(file, raw.replace('title: Extension host smoke', 'title: Updated host smoke'));
      await vscode.commands.executeCommand('research.refresh');
      assert.equal((await api.treeChildren())[0].label, 'Updated host smoke');
    });
    await check('Page navigation remains responsive while a long operation occupies the mutation queue', async () => {
      let release;
      const blocked = new Promise(resolve => { release = resolve; });
      const waiting = api.enqueue(() => blocked);
      let timer;
      try {
        const started = performance.now();
        const state = await Promise.race([
          api.command({command: 'selectSection', payload: {section: 'Ideas'}, requestId: 'host-navigation'}),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Navigation waited for the mutation queue')), 1000); }),
        ]);
        assert.equal(state.section, 'Ideas');
        assert.ok(performance.now() - started < 1000);
        assert.equal(state.selectedProjectId, 'project-smoke');
      } finally { clearTimeout(timer); release(); await waiting; }
      await api.command({command: 'selectSection', payload: {section: 'Overview'}});
    });
    await check('Queued project actions retain the project selected when requested', async () => {
      await api.command({command: 'saveEntity', payload: {entity: {id: 'project-other-smoke', kind: 'Project', title: 'Other smoke project', status: 'Active', body: 'Temporary context check.'}}});
      let release;
      const waiting = api.enqueue(() => new Promise(resolve => { release = resolve; }));
      await Promise.resolve();
      const action = api.command({command: 'reportOpen'});
      const rejected = assert.rejects(action, /selected project changed/i);
      try {
        await api.command({command: 'selectProject', payload: {projectId: 'project-other-smoke'}});
      } finally { release(); await waiting; }
      await rejected;
      await assert.rejects(api.command({command: 'reportOpen', payload: {contextProjectId: 'project-smoke'}}), /selected project changed/i);
      await api.command({command: 'selectProject', payload: {projectId: 'project-smoke'}});
    });
    const originals = [], parkedRecords = [];
    const version = record => ({expectedRevision: record.revision, expectedHash: record.contentHash});
    await check('Create temporary Idea and Experiment records through the real host API', async () => {
      const records = [
        {id: 'idea-back-burner-smoke', kind: 'Idea', title: 'Host shared idea', status: 'Exploring',
          links: [{target: 'experiment-back-burner-smoke', relation: 'tested_by'}], body: 'Preserve this research motivation.'},
        {id: 'experiment-back-burner-smoke', kind: 'Experiment', title: 'Host running comparison', status: 'Running',
          links: [{target: 'idea-back-burner-smoke', relation: 'explores'}], body: 'Preserve the comparison protocol.', metadata: {results: {accuracy: 0.93}}},
      ];
      for (const record of records) {
        const entity = {...record, projectIds: ['project-smoke'], sources: [{path: process.env.RESEARCH_SMOKE_SOURCE, line: 3}]};
        const state = await api.command({command: 'saveEntity', payload: {entity}});
        const created = state.entities.find(item => item.id === entity.id);
        assert.ok(created);
        assert.equal(created.status, entity.status);
        assert.equal(created.metadata.author, 'human');
        assert.equal(created.revision, 1);
        assert.deepEqual(created.links, entity.links);
        originals.push(created);
      }
    });
    await check('Human Back burner commands preserve scientific status, links, sources, and results', async () => {
      for (const original of originals) {
        const reason = `Revisit this ${original.kind.toLowerCase()} after the comparison`;
        const state = await api.command({command: 'setBackBurner', payload: {id: original.id, active: true, reason, ...version(original)}});
        const parked = state.entities.find(item => item.id === original.id);
        assert.equal(parked.metadata.backBurner.active, true);
        assert.equal(parked.metadata.backBurner.reason, reason);
        assert.equal(parked.metadata.backBurner.by, 'human');
        assert.equal(parked.status, original.status);
        assert.equal(parked.body, original.body);
        assert.deepEqual(parked.links, original.links);
        assert.deepEqual(parked.sources, original.sources);
        assert.deepEqual(parked.metadata.results, original.metadata.results);
        assert.equal(parked.revision, original.revision + 1);
        assert.notEqual(parked.contentHash, original.contentHash);
        parkedRecords.push(parked);
      }
    });
    await check('Stale restores conflict; current restores preserve context and durable Markdown history', async () => {
      for (const original of originals) {
        const parked = parkedRecords.find(item => item.id === original.id);
        await assert.rejects(api.command({command: 'setBackBurner', payload: {id: original.id, active: false, ...version(original)}}), /changed|conflict/i);
        const afterConflict = (await api.snapshot()).entities.find(item => item.id === original.id);
        assert.equal(afterConflict.contentHash, parked.contentHash);
        assert.equal(afterConflict.metadata.backBurner.active, true);
        const state = await api.command({command: 'setBackBurner', payload: {id: original.id, active: false, ...version(afterConflict)}});
        const restored = state.entities.find(item => item.id === original.id);
        assert.equal(restored.metadata.backBurner.active, false);
        assert.equal(restored.metadata.backBurner.restoredBy, 'human');
        assert.equal(restored.metadata.backBurner.reason, parked.metadata.backBurner.reason);
        assert.equal(restored.metadata.backBurner.at, parked.metadata.backBurner.at);
        assert.equal(restored.status, original.status);
        assert.equal(restored.body, original.body);
        assert.deepEqual(restored.links, original.links);
        assert.deepEqual(restored.sources, original.sources);
        assert.deepEqual(restored.metadata.results, original.metadata.results);
        assert.equal(restored.revision, original.revision + 2);
        const historyDirectory = path.join(process.env.RESEARCH_SMOKE_MEMORY, 'history', original.id);
        const historyFiles = await fs.readdir(historyDirectory);
        assert.equal(historyFiles.length, 2, 'Rejected edits must not create history');
        const previous = await Promise.all(historyFiles.map(file => fs.readFile(path.join(historyDirectory, file), 'utf8')));
        assert.ok(previous.some(raw => raw.includes('active: true') && raw.includes(parked.metadata.backBurner.reason)));
        assert.ok(previous.every(raw => raw.includes(original.body) && raw.includes(`status: ${original.status}`)));
        assert.match(await fs.readFile(restored.filePath, 'utf8'), /active: false/);
      }
    });
    await check('Experiment previews deliver linked images and tables without changing navigation', async () => {
      const directory = path.dirname(process.env.RESEARCH_SMOKE_SOURCE);
      const figure = path.join(directory, 'result.png');
      const table = path.join(directory, 'summary.csv');
      await fs.writeFile(figure, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=', 'base64'));
      await fs.writeFile(table, 'method,score\nbaseline,0.6\nours,0.9\n');
      await api.command({command: 'saveEntity', payload: {entity: {id: 'artifact-preview-host', kind: 'Artifact', title: 'Measured host results', status: 'Available', projectIds: ['project-smoke'], sources: [{path: figure}, {path: table}], body: 'Temporary evidence.'}}});
      await api.command({command: 'saveEntity', payload: {entity: {id: 'experiment-preview-host', kind: 'Experiment', title: 'Host preview comparison', status: 'Completed', projectIds: ['project-smoke'], links: [{target: 'artifact-preview-host', relation: 'produced'}], body: '## Setup\nCompare paired seeds.'}}});
      const before = await api.snapshot();
      const preview = await api.command({command: 'previewEntity', payload: {id: 'experiment-preview-host', token: 'host-preview'}});
      assert.equal(preview.entityId, 'experiment-preview-host');
      const result = preview.records.find(record => record.entity.id === 'artifact-preview-host');
      assert.ok(result);
      assert.ok(result.sources.some(source => source.kind === 'image' && source.dataUrl.startsWith('data:image/png;base64,')));
      const csv = result.sources.find(source => source.kind === 'table');
      assert.deepEqual(csv.columns, ['method', 'score']);
      assert.deepEqual(csv.rows, [['baseline', '0.6'], ['ours', '0.9']]);
      const after = await api.snapshot();
      assert.equal(after.section, before.section);
      assert.equal(after.selectedProjectId, before.selectedProjectId);
    });
    report.passed = true;
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.error = error.stack || String(error);
    throw error;
  } finally {
    if (resultPath) await fs.writeFile(resultPath, JSON.stringify(report, null, 2) + '\n');
  }
};
