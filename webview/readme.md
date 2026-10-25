# Webview

The React interface for the Research Manager editor panel. All visible copy is English.

- `main.tsx` receives `AppState` from the extension, renders sections, and sends commands. A browser preview uses `/api/state` and `/api/command` with the same payloads.
- `Graph.tsx` builds the research map and lays out card nodes with ELK and React Flow. Overview starts from claims and their evidence; Experiments hides shelved Ideas/Experiments and evidence branches exclusive to shelved experiments. Shared evidence and active experiments remain. Overview preserves historical evidence with a Back burner marker. Maps start with one or two levels and six connections per branch, with more connections available on demand. Selection preserves the viewport; collapse and search change the visible branch. Additional relationships stay accessible in record details.
- `EntityDetails.tsx` hosts the expandable details panel, source links, record editing, and explicit claim judgments or evidence invalidation.
- `ExperimentPreview.tsx` separates Setup and Results, requests evidence on selection, and shows directly linked observations, interpretations, figures, and tables. Request tokens prevent late previews from appearing in another record.
- `Markdown.tsx` renders CommonMark, GFM tables, and dollar-delimited inline/display LaTeX using remark-math and KaTeX. KaTeX CSS and fonts ship locally in dist; no CDN is required. Raw HTML and trusted TeX commands remain disabled. Long display equations scroll within their panel. The component opens file links through the host and enlarges validated local images in a keyboard-accessible overlay.
- `styles.css` follows VS Code theme variables with browser fallbacks and responsive details panels.

The host sends `{ type: 'state', state }`, `{ type: 'saved', id }`, or `{ type: 'error', message }`. The interface sends `{ command, payload }`. Browser command responses may include `savedId`. Editors close only after a successful save; conflicts retain the draft.

Read-only `previewEntity {id, token}` replies with `{type: 'entityPreview', entityId, token, preview}` or a scoped error. It does not replace application state or occupy the mutation queue. Images arrive as validated raster data URLs, with separate maps for Markdown references. Tables preserve literal values and label truncation; missing sources remain visible. Reload previews reads changed output files even when the record itself has not changed. Shared figure collections and invalid evidence retain their labels.

Overview uses the project goal and a next-proposal excerpt from the most recent Handoff note. The excerpt opens its full source. Record connections support Back with restored reading position; Escape closes details and returns focus without moving the map. Claim details show the accepted status separately from Needs review, label unconfirmed suggestions, and read both `conditions` and the imported `scope` field. Code provenance is available under Source details.

New exploration briefs start with Question, Setup, and Planned readouts. Validation adds the claim, controls, parameter selection, and judgment criteria. Switching type changes an untouched template only; it preserves user text. Experiments linked to ideas use `explores`, while claim links use `tests`.

Commands: `ready`, `selectProject`, `selectSection`, `refresh`, `codeMode`, `selectSource`, `openSource`, `openEntity`, `saveEntity`, `reviewClaim`, `invalidateArtifact`, `setBackBurner`, `submitRun`, `reconcileRun`, `connectDrive`, `listDrive`, `linkDriveFile`, `reportSync`, `reportPush`, `reportOpen`, and `configureProject`. New project uses `configureProject {create:true}`.

Record writes include the original `expectedRevision` and `expectedHash`. Review and invalidation capture these when their form opens. Existing entity fields, including its content hash, are retained during editing. The host checks conflicts and owns persistence, source access, credentials, and all external actions.

Run `npm run check` and `npm run build` from the repository root. `npm run preview` opens the same interface against the preview server; it never invents research evidence.


Ideas use Current / Back burner plus project scope; Experiments provides Research map / Back burner / Runs. Counts follow scope, search points to shelved matches, and detail panels stay open after placement changes. The adjacent optional-reason form captures the displayed revision/hash; shared-project and running-job effects are explicit. Restore preserves scientific status. Placement is defined by the shared `src/workflow.ts` helpers, not a second UI-only status.

Section clicks render immediately from current state. Host messages carry a request ID and navigation revision so old requests cannot undo newer navigation. Graph geometry uses a bounded topology cache: content/selection updates do not run ELK again. Initial graph fitting waits for measured nodes without an artificial delay; Reset/Expand retain their animation.

`Review.tsx` builds the default experiment reading path from explicit Markdown sections. It prefers measured tables over feedback history, preserves source paragraphs and limits, labels missing summaries, and shows current Claim status separately from experiment completion. Setup and Results preserve the full records; raw tables are collapsed with dimensions.
