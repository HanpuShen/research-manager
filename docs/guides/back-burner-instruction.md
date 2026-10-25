# Claim loop and back burner (v1)

The research graph should show the current argument, not every attempt. Claims are decided by experiments with rules written in advance; decided or outdated work moves to the **back burner** so the mainline stays short. Nothing is deleted: shelved records keep their evidence, history and links, and can be restored.

## 1. The claim loop

1. **Claim** (`status: Open`): `## Statement` with conditions; `metadata.answer` reads `Not tested yet — <what would decide it>`. See the project overview skill.
2. **Experiment brief** that `tests` the claim, with `## Decision rule` written *before* the run. See the experiment instruction.
3. **Run** and an **Observation** note with `## Main finding`, `## Measured results`, `## Limits`.
4. **Result**: the experiment's `## Result` starts `Rule met: yes / partly / no — <deciding numbers>`; status `Completed`.
5. **Proposal**: `research lint PROJECT` lists the claim under `readyForVerdict` once every experiment testing it is Completed with a `Rule met`. Propose with `research_propose_verdict` (yes → Supported, partly → Mixed, no → Refuted; disagreeing experiments → Mixed). Explain the deciding numbers in the reason.
6. **Verdict**: only the researcher sets the claim's status. Reviewing the claim marks its open proposal Notes `Reviewed`.
7. **Prune**: decided, refuted or orphaned work appears under `backBurnerCandidates`. Shelve only what the researcher agrees to.

`research context CLAIM_ID` returns the claim with its experiments' decision rules and results, observations' main findings and limits, interpretations, papers and neighbouring claims: read that instead of the whole project.

## 2. What the back burner is

| It is | It is not |
|---|---|
| A reversible planning decision for Ideas, Experiments and Claims | Evidence invalidation (use **Mark evidence invalid** on the Artifact) |
| A way to take records off the authored map and the Overview argument | Deletion, or cancelling running jobs |
| Recorded with a reason, a category and who moved it | A verdict: a shelved claim keeps its status and review |

Shelved records still appear in **Experiments → Back burner**, **All records**, search and `research list`. The compact handoff counts them and leaves them out of "changed since handoff".

## 3. Categories

| Category | Use when | Also set |
|---|---|---|
| `refuted` | The researcher refuted the claim, or the experiment's claim was refuted | — |
| `superseded` | A sharper claim or a better experiment replaced it | `supersededBy` (CLI `--superseded-by ID`) |
| `merged` | Its content now lives in another idea | `mergedInto` on the idea |
| `out-of-scope` | Not part of the current question | — |
| `deprioritized` | Still relevant, but not now (compute, data, order) | — |

A failed run is not a reason by itself: record the failure, and shelve only when the plan changes.

## 4. A pruning session

1. Run `research lint PROJECT`.
2. Show the researcher the `backBurnerCandidates` as a table: title, category, why.
3. For each approved record: `research get ID`, then `research park ID "<reason>" --category C [--superseded-by ID] --revision N --hash H` (MCP `research_set_back_burner`).
4. If a shelved claim carried the key negative result, keep that result in the Project's `## Current answer`.
5. End with a Handoff note listing what moved and why.

Restore with `research restore ID --revision N --hash H`; progress made while shelved is kept.

## 5. Self-check

- [ ] Every shelved record has a category and a reason the researcher agreed to.
- [ ] `superseded` records name their replacement.
- [ ] No claim status was changed by you; proposals are Notes.
- [ ] `research lint` reports no `error` issues.
