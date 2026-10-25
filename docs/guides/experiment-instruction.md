# Experiment instruction (v3)

One Experiment answers **one question** that tests **one claim**. Methods, baselines, seeds and settings are arms and runs inside it, never separate Experiments.

## 1. Where an experiment goes

- **Arms of the same experiment**: same setup and question, different methods or settings.
- **Child experiment**: keeps the parent's setup and changes one factor, or answers a narrower part of the parent's question. Link it `child_of → parent` and add the map edge `parent → child` labelled `Child: <changed factor>`.
- **Sibling experiment**: same broader question, materially different setup or protocol (other data scale, other benchmark, an offline analysis of existing checkpoints). No parent link.

## 2. Experiment record

- **Title**: the question as a short phrase, ≤ 45 characters ("Is the distilled critic needed?").
- **Links**: `tests → claim`; `produced → figure artifact`; `child_of → parent` for children; the Observation links back with `discusses`.
- **Body**, in this order. The Review tab shows the tested claim, Question, Why this comparison, Decision rule and the Observation; Setup shows the whole brief.
  1. `## Question` — one sentence ending in "?". Name the tasks.
  2. `## Why this comparison` — the alternative explanation or uncertainty it removes, and how each outcome would change the claim.
  3. `## Placement` — "Tests claim N." plus parent / child / sibling and why; what stays fixed and what changes.
  4. `## Setup and controls` — a table `Arm | What it isolates`; then data, seeds, metric, aggregation unit and the meaning of ±. Define every abbreviation used in the table.
  5. `## Decision rule` — written before the run: what result supports, weakens or refutes the claim. When registering work that already ran, title the section `## Decision rule (reconstructed after the run)` and keep it qualitative: no numeric threshold chosen after seeing the result. The Review tab marks such rules.
  6. `## Result` — one sentence starting `Rule met: yes / partly / no —` with the deciding numbers. No explanations. It is shown at the top of the Review tab. A planned experiment has `status: Planned` and `## Result` reads `Not run yet.`; its Question, Why this comparison, Setup and Decision rule are written before any run, and runs are linked once submitted (`research_prepare_run`).

## 3. Observation note (`metadata.role: "Observation"`, `discusses → experiment`, `evidence → claim`)

- `## Main finding` — one paragraph: the result with its conditions, and a counterexample or limit.
- `## Measured results` — one sentence first: units, aggregation unit (per task, environment average, a single task), number of seeds, meaning of ±, and the source of the numbers (`Table N`, `computed from Table N`, `~ read from Figure N`). Then a compact table: ≤ 7 rows, ≤ 5 columns, full task names, best per row in bold, and a line `Omitted: …` naming dropped rows or columns. Never write "curves only"; give approximate values with `~`. Put file paths and globs in backticks. A value missing from your sources is written as unknown, never assumed.
- `## Limits` — what this result cannot establish.

Put explanations in a separate Interpretation note. Each fact appears once in full (Main finding); the claim's Evidence bullet and the Result repeat only the deciding number. Before finishing, re-read every sentence of the Main finding against the table below it — a general statement ("level at h = 5") must hold for every row. For your own runs, name the job or run ID and the result file next to each number.

## 4. Figures

Put figures in a folder with a `figure-inventory.json`, one entry per figure:

```json
[{"name": "fig3", "title": "Figure 3 · Distilled critic ablation", "kind": "result",
  "caption": "…", "readingGuide": "x: …; y: …; compare … with …; look for …",
  "artifacts": [{"path": "fig3.png"}]}]
```

One Artifact per experiment has that inventory as its source and is linked from the experiment with `produced`. List the most important figure first. The reading guide names the axes, the exact visual encoding (colour, marker, line style — checked against the image), which curves or rows to compare, what the band or ± means, and the pattern to look for. Prefer a Markdown table in the Observation over an image of a table.

## 5. Paper studies

`status: Completed`; `metadata.experimentType: "validation"`; the Decision rule states what the paper needed to show; the Observation names the paper's table or figure for every number.

## 6. Self-check before you finish

- [ ] Title ≤ 45 characters; `tests` link to exactly one claim; `child_of` children also have a `Child:` map edge.
- [ ] Decision rule written before the result; Result starts `Rule met:` and agrees with the claim's verdict.
- [ ] Every number has a source and aggregation unit; plot readings have `~`; computed values say so.
- [ ] Main finding re-read against its own table; the counterexample is real.
- [ ] Tables ≤ 7 rows × 5 columns with an `Omitted:` line; reading guides checked against the image.
