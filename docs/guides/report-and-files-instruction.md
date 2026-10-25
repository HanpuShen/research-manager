# Report and files instruction (v1.1)

How an agent works with the project's LaTeX report (an Overleaf Git clone) and with files linked from Google Drive or the web.

## 1. The report

The project's `metadata.report` (`path`, `remote`, `mainFile`) names a local Git clone of the Overleaf project. Every tool takes the project id; you never need the path.

1. `research_report_status` (CLI `report-status PROJECT`): branch, `state` (`clean`, `dirty`, `ahead`, `behind`, `diverged`, `offline`, `unconfigured`), ahead/behind counts, changed files. It does not contact Overleaf: counts are as of `lastFetchedAt`, so sync before trusting `behind 0`. LaTeX build output (`.aux`, `.log`, …) is listed as `ignoredBuildFiles` and never blocks a sync; new `.tex`/`.bib`/figure files do.
2. `research_report_sync` (CLI `report-sync PROJECT`) before you edit: fetches and fast-forwards only. It never overwrites local edits; `dirty` or `diverged` means stop and tell the researcher.
3. `research_report_outline` (CLI `report-outline PROJECT`): the `.tex`/`.bib` files and every `\section`-level heading with file and line.
4. `research_report_read` (CLI `report-read PROJECT FILE [--section TITLE]`): one section, or a line window (`offset`, `limit`, default 200 lines). Read sections, not whole files.
5. Edit `.tex` files with your own file-editing tools, then commit locally with a clear message.
6. **Publishing to Overleaf is the researcher's action** (Report page → Publish). No agent tool pushes.

Every number you write into the report comes from an Observation note; cite the claim or experiment it supports in a LaTeX comment (`% claim-…`) so it can be traced. Keep claims in the report no stronger than their status in Research Manager.

## 2. Linked files

`research_linked_files` (CLI `files PROJECT [QUERY]`) lists the Drive and web files that records cite in their `sources`, with the records that cite each one. It works offline and never contacts Google.

Research Manager does not read Drive file contents: Drive credentials live only in the VS Code extension. To read a Drive file, use a dedicated Google Drive MCP server with read-only scopes (for example taylorwilsdon/google_workspace_mcp in read-only mode). Link a Drive file to a record from the **Files** page, or append it with `research_update` and `patch.addSources: [{"url": "https://drive.google.com/…", "label": "…"}]` (no need to resend existing sources).

## 3. Self-check

- [ ] Report state was `clean` or `behind` before editing, and synced.
- [ ] You read sections through the outline, not whole files.
- [ ] Every new number in the report has an Observation note behind it.
- [ ] Your changes are committed locally and the researcher knows they are ready to publish.
