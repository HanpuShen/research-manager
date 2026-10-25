# Shared research workflow

Use this guide for projects registered in Research Manager. Keep project-specific scientific instructions in force.

1. Start with `research projects`, then `research handoff PROJECT_ID`. Read cited files before relying on an observation. A missing source, unknown runtime version, or Needs review flag is part of the context.
   The handoff is compact: overview section summaries, the primary Handoff Note in full, mainline cards (`overviewNodeIds`, else `nodeIds`, else Claims), `notOnMainline` claims the handoff discusses but the mainline omits (tell the researcher), active records changed since that handoff, and counts. `list` returns cards (`id`, `kind`, `title`, `status`, `placement`, `role`, `updatedAt`, `summary`); `list PROJECT --kind K --limit N` narrows the (otherwise complete) card list; `search` returns `{total, truncated, results}` with cards ranked by relevance (`--limit N`, default 50). Read only what the task needs with `research get ID`; use `--full` (MCP `full: true`) only when every body is required. A card summary is the first paragraph of `## Main finding`, `## Summary`, `## TL;DR`, `## Statement`, or `## Question`, else of the body, so write that paragraph to stand alone.
2. After a substantive discussion, draft a short Idea with the question, motivation, alternatives, and source references. Set status Inbox unless its research status was already decided. Ideas may belong to several projects.
3. Before a new comparison, create an Experiment brief. Exploration needs a question, setup, and planned readouts. Confirmation additionally needs a claim, comparison protocol, and decision/parameter-selection rule. Preserve exploratory history when deriving a later claim.
4. Prepare a run through the CLI/MCP with explicit resources and a stable request ID. Inspect the frozen source/input manifest. Submit only within the researcher's existing scope and resource authorization. Reuse the same request ID when a response is lost; reconcile Unknown before taking further action.
5. Write observations and interpretations as separate Notes (`metadata.role`). Link evidence and identify conditions. An exit code is operational state, not a scientific judgment. Keep failed attempts, partial successes, and superseded explanations.
6. Propose claim verdicts using `research_propose_verdict`; the researcher confirms them. Do not edit accepted verdicts or human review metadata directly. Mark invalid evidence with a reason so dependent claims need review.
7. End a work session with a sourced handoff: current goal, observations, interpretations, decisions, failed approaches, operational incidents, missing information, and next proposals.

## Readable experiment results

Keep the experiment brief's setup and comparison protocol in its Markdown body. Save measurements in linked Observation Notes and tentative explanations in separate Interpretation Notes. Link result Artifacts to the experiment with `produced` or `produces`, and put actual image/table/document paths in the Artifact's `sources`. A declared Artifact `metadata.path` may point to its output directory. The experiment detail view can then show the setup and linked results together.

Use Markdown tables for concise summaries and `![Caption](path/to/figure.png)` for inline figures. Relative image paths are resolved from the Markdown record or source document containing them. CSV/TSV sources receive table previews; PNG/JPEG/GIF/WebP sources receive image previews. A file reference keeps the original output authoritative. Large tables are truncated visibly in preview, with the full source still available. Figure inventory entries can provide a title, `kind` (`setup`, `result`, or `supplement`), caption, and an `artifacts` list of file paths. Shared figure collections retain their labels; link a specific figure when only that figure applies to an experiment.

For a 1–3 minute review, write the experiment's `## Question` as a short paragraph. In the linked Observation, add `## Main finding` (one intact paragraph with conditions and a counterexample or limit), `## Paired observations` or `## Measured results` (a compact comparison table), and `## Limits`. Put the table's baseline, subtraction order, units, number of independent reporting units, and meaning of uncertainty before the table. Keep planned outcomes and explanations out of measured sections. The Review tab uses these explicit sections and links back to the original record; it does not generate a semantic summary. Without a short finding, it labels that gap.

Give each figure inventory entry an optional `readingGuide` string: what each axis represents, which panels/conditions to compare, baseline and error-band meaning, and the particular pattern to inspect. An optional `tableGuide` explains its data table. Keep every statement supported by the linked output; preserve counterconditions. A caption describes the figure; a reading guide tells the reader how to examine it. Missing guides are shown explicitly. The viewer does not infer a chart's meaning from its filename or colors.

The interface reads recorded evidence; it does not infer results from a job exit code, invent missing summaries, or accept a claim verdict. Keep provenance, invalidation notices, and limitations attached to the same records.

## Safe collaboration

Read records before updating them. Send their exact `revision` and `contentHash`; on Conflict, reread and deliberately reconcile. Do not overwrite a complete file from an old copy. A stable record ID must not be changed by hand. Record links rather than copying the same accepted conclusion into several files.

Back burner is a reversible planning decision for Ideas, Experiments and Claims. Use `research park ID "Reason" --category C [--superseded-by ID] --revision N --hash HASH` / `research restore ID --revision N --hash HASH`, or `research_set_back_burner` with `active: true` / `false`. A reason is optional, but record why the work can wait when known. A shared record moves across all its projects. Do not infer low priority from a failed run or change placement without the researcher's task context supporting that decision.

`metadata.backBurner` holds placement separately from research status. Handoffs mark shelved records and retain their sources and reasons; ordinary list/search still includes them. Keep shelved work out of immediate next-step proposals unless deliberately reconsidering it. Shelving never invalidates evidence or cancels jobs. Use evidence invalidation for unusable results. Restore preserves scientific progress; do not reset a completed experiment to an earlier status. All changes use normal revision/hash conflict detection and history. The UI shows the latest shelving cycle; older cycles remain under `history/<id>/`.

Merged ideas remain readable; `mergedInto` / `merged_into` points to the current idea without deleting the original discussion. Do not treat a merge as deletion of its experiments.

Markdown is the source of truth. The database is a local index. Use the shared API for agent edits; human text edits are indexed on refresh. Invalid YAML leaves the last valid record visible with an error. A lock left by a crashed writer must be checked against its recorded host/PID before manual recovery; do not remove another active writer's lock.

## Related work

Papers are `Paper` records that belong to exactly one project; add a separate copy to share one with another project. Add them with `research_add_paper` (an arXiv link fills the metadata; other links need a title) rather than writing the record by hand, and attach PDFs with `research_attach_paper_pdf`. Write its body (the paper's notes) as in `research guide related-work`: `## TL;DR`, `## Why it matters here`, and the rest; link it to the experiment or claim it informs (`builds_on`, `baseline`, `compares_with`, `supports`, `refutes`, `cites`). A paper's reported results are the paper's claims, not evidence produced in this project.

## MCP tools

`research_handoff`, `research_search`, `research_get`, `research_context`, `research_lint`, `research_guide`, `research_create`, `research_update`, `research_set_back_burner`, `research_propose_verdict`, `research_add_paper`, `research_import_papers`, `research_attach_paper_pdf`, `research_report_status`, `research_report_sync`, `research_report_outline`, `research_report_read`, `research_linked_files`, `research_prepare_run`, `research_submit_run`, `research_runs`, `research_refresh_runs`, and `research_code_map` use the same implementation as the CLI and VS Code. None reads private agent chat history automatically.
