# Project overview skill (v3)

Goal: a newcomer opening the **Overview** page can, within two minutes, say what is asked, why it is hard, the key idea, the chain of claims with their answers, and the current answer to the question — and click any claim for its evidence.

The overview is an argument, not a history. Order claims by logic, not by when the work was done.

## 1. Project record body

The app renders the body on the Overview page; the claim list is built from the claims themselves (section 2), so do **not** write an "Argument" section.

1. **First paragraph** (no heading) — one sentence saying what the project is and defining its own method in plain words (not just its name); it becomes the page subtitle. Paper study: `<first author> et al. (<venue>): <method in one clause>.`
2. `## Question` — one sentence ending in "?".
3. `## Why it is hard` — the obstacle or trade-off that defeats the obvious approach, in 2–4 sentences. Name both sides of a trade-off.
4. `## Key idea` — the move that resolves it, in ≤ 2 sentences, concept only. Mechanisms, losses and hyperparameters belong in experiment setups.
5. `## Current answer` — yes / partly / no, under which conditions, and the most important negative result, with numbers.
6. `## Next decision` — what would change the plan (paper study: the open problems the authors name).

Sections 2–6 together: ≤ 250 words. Define every abbreviation at first use. Use one unit per quantity (e.g. success always in %, never mixed with fractions) and write math as `$…$`. The Overview shows the Question, then the Current answer, then Why it is hard and Key idea, then the claim list, then Next decision.

## 2. Stage claims (3–6 Claim records)

- **Title** `N. <assertion>`: ≤ 45 characters (it must fit two lines of a map card), present tense, testable. Not a topic ("Model error") but a statement ("Action chunks curb model error").
- **Strength**: the title may not be stronger than the decision rule of its experiment(s) supports. Avoid *necessary, essential, always, fails, drives* unless an experiment tested exactly that and met its rule.
- **`metadata.answer`**: one clause, ≤ 15 words, with the decisive number and its unit ("74% vs 63% mean success over 5 tasks").
- **`metadata.conditions`**: where the claim holds (tasks, data, seeds).
- **`metadata.reportedVerdict`** (paper studies only): `Supported`, `Mixed` or `Refuted` — your reading of what the source shows, not the researcher's judgment. It must match the `Rule met` of the claim's experiment(s): yes → Supported, partly → Mixed, no → Refuted. Claim `status` stays `Open` until the researcher reviews it.
- **Claims whose experiments have not run**: `metadata.answer` is `Not tested yet — <what would decide it>`; the claim still needs its Statement and Why this step.
- **Body**: `## Statement` (with conditions), `## Why this step` (how it follows from the previous claim or the obstacle), `## Evidence` (one bullet per experiment or derivation: its *title in italics* — never a record ID — then one clause with the number), `## Limits`.
- **Order** (drop what does not apply): premise or theory → main claim (it works, where, against what) → mechanism (the intermediate quantity moves as predicted) → which components matter (ablations) → robustness and limits.
- A proof or derivation is an `Artifact` with `metadata.role: "Derivation"`, its source pointing at the theorem, linked from the claim with `evidence`.

## 3. Authored map (`metadata.researchFlow`, version 1)

- `overviewNodeIds`: the stage claims in order (they drive the Overview list).
- `nodeIds`: stage claims, derivations and experiments. The Experiments map lays claims out in one column, each claim's tests to its right, children further right.
- `edges`:
  - `project → claim 1`: `Question`.
  - `claim k → claim k+1`: the logical relation, ≤ 3 words (`so decouple`, `why it works`, `which part matters`, `how robust`). Shown between claims on the Overview.
  - `claim → experiment` or derivation: `Test: <what varies>` / `Proof`, ≤ 3 words after the colon, naming the manipulated factor or comparison (`Test: vs ablations`, `Test: K = 1–16`), not a count (`Test: 6 tasks`).
  - `experiment → child experiment`: `Child: <changed factor>`. Every child relation in the records must also be an edge.

## 4. Paper studies

Title `Paper study: <full paper title>`; `metadata.mock: true`; `metadata.paper` with title, authors, venue, link and code. Keep the PDF and figure crops under `library/<project>/` (outside Git). Mark every number as reported by the paper (`Table N`, `Figure N`), computed from it (`computed from Table N`), or read from a plot (`~`, `read from Figure N`). **Check every statement about a figure against the image itself, not the caption or the paper's prose.**

## 5. Self-check before you finish

- [ ] Each claim title ≤ 45 characters and no stronger than its experiments' decision rules allow.
- [ ] Each claim has `metadata.answer` (≤ 15 words, a number with its unit) and, for studies, a `reportedVerdict` matching its experiments' `Rule met`.
- [ ] `overviewNodeIds` lists the claims in logical order; every consecutive pair has a labelled edge.
- [ ] The Current answer states the most important negative result with its number.
- [ ] No record IDs in prose; abbreviations defined; one unit throughout.
