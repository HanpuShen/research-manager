# User guide

The complete reference for the Research Manager app, CLI and MCP server. For an overview with screenshots, see the [README](../README.md). The UI uses English and works in a Remote SSH window.

## Open the app

Install `research-manager-0.1.9.vsix` from [Releases](https://github.com/HanpuShen/research-manager/releases) in your connected VS Code window using **Extensions → … → Install from VSIX**. Run **Research Manager: Open** from the command palette, or select the Research activity-bar icon.

The default memory folder is `~/Project/research-memory`. Change it using **Research Manager: Set Memory Folder**.

- `Overview`: follow claims, conditions, and evidence. Click a card for details.
- `Ideas`: use All projects to find shared ideas; create, edit, merge by reference, or move them to Back burner.
- `Experiments`: current comparisons, Back burner, and managed runs or observed jobs.
- `Related work`: the project's papers with code links, PDFs, BibTeX, reading status, and notes.
- `Source Code`: switch Data flow / Modules and choose a repository. Click Open code to open the linked file beside the map. Algorithm edges marked Inferred are explanations, not measured runtime traces.
- `Report`: open local LaTeX, sync a clean fast-forward clone, and explicitly push committed changes.
- `Files`: connect Drive, set a project folder, browse recursively, search file names, filter types, and link files to records.

## Experiment details

Open an experiment card in **Review** for the question, current claim status, sourced measured evidence, and its limits. The short comparison table keeps its recorded baseline and uncertainty explanation. **Setup** and **Results** retain the full brief and evidence. Raw file tables start collapsed with dimensions; figures can include an authored reading guide. Missing summaries and guides are labeled rather than invented. Markdown tables render as tables, dollar-delimited inline/display formulas render with locally bundled KaTeX fonts, local image references appear inline, and linked CSV/TSV files have scrollable table previews. Figures can be enlarged without leaving the manager; Open file keeps the original source accessible. Related Observation and Interpretation notes remain separately labeled, and invalid evidence retains its warning.

Previews load when a record is opened, independently of page navigation. Large files and tables have explicit preview limits; unsupported or missing files retain an explanatory message and source link. The viewer also reads declared artifact folders and figure inventories so existing research outputs do not need to be copied into Markdown. It does not scan unrelated project directories or change the research records.

## Page switching

Pages open from the current local index immediately. Slurm polling and Overleaf synchronization run independently of navigation; repeated timer ticks coalesce while a refresh is still active. Manual Refresh and the regular poll bring in external record changes. Source maps are reused on return and refreshed on explicit mode/repository changes or while the Source Code page is active during polling. A late response cannot switch the interface back to an earlier page.

## Related work

Each project keeps its own list of papers. Open **Related work** and select **Add paper**. Paste an arXiv link or ID to fill in the title, authors, year, abstract, and BibTeX; add GitHub links for the code to record each repository's name, description, and stars. Only the links are sent to arXiv and GitHub. Other links (OpenReview, a lab page) need a title. If a lookup fails, enter the title and add the paper anyway; the reason is shown with the paper, and **Refresh metadata** tries again.

A paper's details show its links, reading status (To read, Reading, Read), tags, notes, abstract, and BibTeX with a copy button. Drop a PDF onto the PDF area or choose one from your computer, or download it from arXiv. PDFs are stored as `library/<project>/<paper-id>.pdf` in the memory folder, outside Git, up to 50 MB; the record keeps the file's size and SHA-256. **Open PDF** uses VS Code's editor for PDFs (install a PDF viewer extension if VS Code shows the file as binary). To use one paper in two projects, add it to each; the copies keep separate notes. Link a paper to an experiment or claim with **Add link** (builds on, baseline, compares with, cites); the experiment then lists it among its related records. Papers do not appear on the research map.

Agents use `research paper-add PROJECT URL --code URL --tag TAG`, `research paper-pdf ID FILE --revision N --hash HASH` (or `--arxiv`), and `research papers PROJECT`, or the MCP tools `research_add_paper` and `research_attach_paper_pdf`.

## Back burner

Open an Idea, Experiment or Claim and select **Move to back burner**. Add an optional reason, then confirm. The record leaves the current collection; its details stay open with **Restore to current**. Find it later under **Ideas → Back burner** or **Experiments → Back burner**. Search also points to matching shelved records. Ideas can be scoped to All projects or This project, and the count follows that scope.

Shelving changes planning priority only. Existing notes, scientific status, verdicts, evidence, and source links remain. Shelved records leave the authored research map and the Overview argument, and stay in Back burner, All records and search; running jobs continue in Runs. To withdraw a result, open its linked Artifact and use **Mark evidence invalid**, with a reason. This triggers claim review independently of shelving. A shared record moves across all its linked projects; the form explains this before confirmation.

**Restore to current** preserves progress recorded while the item was set aside. The details show the latest move and restoration; every earlier version remains in `research-memory/history/<record-id>/`. Existing Idea or Experiment records with status `Parked` appear in Back burner without a migration. Restoring a legacy record uses its recorded prior status, or Open when none is known.

The CLI exposes `research park ID "Optional reason" [--category deprioritized|superseded|refuted|out-of-scope|merged] [--superseded-by ID] --revision N --hash HASH` and `research restore ID --revision N --hash HASH`; MCP exposes `research_set_back_burner`. Both require the version returned by the last read.

## Connect Google Drive

Enable the Google Drive API in your Google Cloud project and create a **Desktop app** OAuth client. Add your Google account as a test user when using a testing consent screen. In Files, choose Connect Google Drive and enter the client ID and client secret from those credentials. Tokens and the client secret are stored in VS Code SecretStorage. Choose Project settings → Drive folder to paste a folder URL or ID.

The extension requests `drive.metadata.readonly`: it reads names, types, dates, links, and folder relationships. File contents open in your browser. Sign-in uses a temporary loopback listener forwarded by VS Code; a Remote SSH desktop window must be able to forward that port. OAuth consent and real-account access require your own credentials. Test-user authorizations can expire; reconnect when prompted.

## Guides, lint, and the claim loop

Agents read the writing guides with `research guide NAME` (or MCP prompts) before writing records: project overview, experiment, related work, back burner, and the default `ponytail` coding skill. `research lint PROJECT` checks the records against those guides and returns grouped issues, claims whose experiments all have a `Rule met` result (ready for a verdict proposal), and back-burner candidates. The Overview shows the same list under **Needs a decision**. Lint never changes a record; the researcher decides. `research context CLAIM_ID` returns one claim's evidence neighbourhood instead of the whole project. See [the back-burner guide](guides/back-burner-instruction.md) for the loop from brief to verdict to pruning.

## Agents and CLI

Read [agent-guide.md](guides/agent-guide.md) for the common research workflow. All CLI output is JSON, except help. `list`, `search`, and `handoff` return compact cards and summaries by default (`search` adds `total` and `truncated`, ranked by relevance); `get ID` returns a full record, and `--full` restores complete bodies. Markdown revisions and content hashes are returned by reads; both are required for updates.

```bash
./bin/research projects
./bin/research handoff project-demo
./bin/research search "value stitching" project-demo
./bin/research get idea-demo
./bin/research context claim-demo
./bin/research lint project-demo
./bin/research guide experiment
./bin/research create idea.json
./bin/research update idea-demo patch.json --revision 1 --hash CONTENT_HASH
./bin/research prepare run.json
./bin/research submit REQUEST_ID
./bin/research runs
```

Use `--memory /absolute/path` before or after the command to choose another memory folder. Set `RESEARCH_NODE` to a Node 24+ binary if the private toolchain is not present.

An MCP client can start the same executable with arguments `--memory /absolute/path/to/research-memory mcp`. See [examples/mcp.json](../examples/mcp.json). The server sends short usage instructions on connect and exposes handoff, search, get, context, lint, guide, create, update, proposed verdicts, back burner, papers (single and BibTeX/link import), the Overleaf report (status, sync, outline, section reading; no push), linked Drive/web files, code maps, and run tools; every parameter is described and every tool is annotated read-only or not. Add `--read-only` after `mcp` to expose only the read tools, for an agent that should analyse but not write. Results are compact JSON; search pages with `limit`/`offset`; writes return the card with the new revision and contentHash; errors say which tool to call next. Every guide in [docs/](readme.md), including the vendored [ponytail](../skills/readme.md) coding skill, is also an MCP prompt and a `research_guide` tool. Human claim review is exposed in the UI and the explicitly human CLI review command, not as an agent MCP tool.

## Managed experiments

Create an Experiment brief before preparing a run. A RunSpec has a persistent request ID, project/experiment IDs, source root, argument-array command, resource limits, optional config/inputs, and optional units. Review [examples/run.json](../examples/run.json) before adapting it to an authorized task.

- `prepare` saves the exact experiment brief and its revision, freezes source including eligible untracked files, and hashes inputs. Large data remain external with identities; unknown dataset identity is visible.
- `submit` creates a Slurm job only after preparation. Retrying the same request does not submit another job. Unknown submissions require reconciliation.
- `units` packs several explicit commands into a single job. Each gets its own outputs and attempt logs; completed units remain available after another unit fails.
- `expectedArtifacts` lists required files relative to each unit's output folder. A zero exit code with missing required files is a failed attempt; present files retain size and hash receipts in the manifest.
- `retryLimit` is the number of in-job retries per unit, default 0. Every attempt uses the same snapshot and checks external input identity. No new Slurm submission is inferred from a failure.
- Source symlinks require an explicit source copy. Source snapshots omit data, checkpoints, caches, and logs; inspect the manifest before submission. Python environments are recorded, not copied or guaranteed immutable.
- Use separate Git worktrees for concurrent code editing. For a generic command, use an explicit entrypoint under `{{source}}`; a shell command that internally reads another working tree cannot be made reproducible by changing its outer working directory. Declare the dataset actually selected by the loader; a declared hash alone does not prove that the loader used that dataset.
- Machine run data live in memory `.runs/`. Preserve this folder when backing up active research; large execution data are excluded from Git.

## Build and verify

```bash
./scripts/bootstrap.sh
export PATH="$PWD/.tools/bin:$PATH"
npm run check
npm run build
npm test
npm run package
```

The bootstrap installs a private Node 24 toolchain, so an older system Node does not matter. SQLite uses a per-user local `/tmp` cache; NFS cache paths are rejected. Cache deletion is safe because records remain in Markdown and run manifests. Back up the memory folder rather than the index.

`npm run preview` serves the real webview on loopback port 4317. This preview supports memory operations but source opening, OAuth, and project configuration belong to the VS Code extension. Set `RESEARCH_MEMORY_ROOT` to a disposable copy for UI testing. the normal test suite covers file concurrency, artifact invalidation, integration adapters, worker retries, and CLI/MCP round trips without submitting GPU experiments.

For real editor integration checks, run `xvfb-run -a .tools/bin/node scripts/extension-smoke.mjs` on a Linux host with Xvfb. This uses a disposable VS Code instance and checks sidebar registration, webview creation, and opening the correct source line. It does not inspect your desktop window.

## Layout

- `src/`: shared memory core, extension host, CLI/MCP, service routing, and experiment execution.
- `src/integrations/`: Overleaf, Drive, and static source maps.
- `webview/`: React interface and graph interaction.
- `tests/`: behavior and integration tests with temporary files and mocked external services.
- `scripts/`: build, bootstrap, preview, and acceptance tools.
- `bin/`: CLI launcher; `media/`: extension icon; `examples/`: agent and run configuration examples.
- `dist/`, `.tools/`, `node_modules/`, and `test-results/` are generated and ignored.

Local development and testing do not publish the extension or send research content to a model service. Existing agents produce semantic notes through the shared interfaces. The manager is a personal workflow tool, not an isolation boundary between agents that already share filesystem access.

## Authored scientific flow

A Project may opt into a curated map with metadata.researchFlow = {version: 1, nodeIds: [...], edges: [{source, target, label}]}. Overview and the current experiment map show that authored argument in the declared direction, rather than rebuilding a hierarchy from all record kinds. Labels such as “next question” express logical order, not established support. Records and their actual evidence links remain unchanged and accessible through details, history notes and Back burner. Missing/cross-project references are visibly marked Needs review. Projects without this metadata keep the existing map behavior.

Optional overviewNodeIds selects a small overview of the scientific stages; the Experiments map retains the full nodeIds. handoffId selects the primary Handoff. The Experiments All records tab provides searchable access to every project record, including records outside the curated map. Non-experiment file previews are collapsed so linked evidence is easier to reach.
