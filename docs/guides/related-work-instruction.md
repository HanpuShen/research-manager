# Related work instruction (v1.4)

One **Paper** record per paper per project. It says what the paper does, why it matters to *this* project, and which of our claims or experiments it bears on. The Related work page lists papers; cards and `research search` show the first paragraph of `## TL;DR`.

## 1. Adding one paper (skill)

The researcher usually gives a paper **name or arXiv link** and expects the stored record to include the **PDF** and the **code (if any)**.

1. `research_add_paper {"projectId", "paper": "<name or link>"}` (CLI `research paper-add PROJECT "<name or link>"`). It finds the paper on arXiv (by exact title for a name; otherwise the closest arXiv titles come back as candidates to choose from), fills title, authors, year, abstract and BibTeX, stores the PDF under `library/<project>/`, and looks for code in four places: the abstract and arXiv comments, the authors' project page (followed one step from the abstract or Hugging Face), the PDF's links, and Hugging Face Papers. A name is first matched against the project's own papers; a paper that is already there is **completed** instead of refused (missing PDF stored, never-checked code searched; `recheck: true` searches again).
2. Read `code.result`:
   - `found`: the authors named the repository in the abstract or comments, on their project page, or on Hugging Face Papers, or two sources agree. It is attached with its GitHub description, stars and `foundIn` (renamed repositories are merged). If it came only from Hugging Face or the project page, glance at the PDF to confirm it is the authors' code.
   - `unconfirmed`: a repository appears only in the PDF's links (often baselines in the appendix or references). PDFs also link to baselines and datasets, so **open the PDF at `pdf.path`** and check the abstract, first-page footnotes, introduction and conclusion for the authors' own release ("code is available at …"). Then call `research_set_paper_code` with that repository, or with `[]` and the reason.
   - `none`: nothing was found. Skim the PDF for a release statement or "code will be released", then `research_set_paper_code` with what you found, or `[]` and the reason (for example "no code release mentioned").
3. Write the body (section 3) from the PDF, not only the abstract, and link the paper (section 4).
4. Tell the researcher: the title, whether the PDF is stored, and the code repository (or that there is none, and why).

For a paper that is not on arXiv, pass its URL and `title`; attach the PDF with `research_attach_paper_pdf {path}` if you have the file, and give its code with `codeUrls` or `research_set_paper_code`. Do not type metadata the tool can fetch.
- A paper belongs to exactly one project. For another project, add a separate Paper there.
- Store the PDF with `research_attach_paper_pdf` (it lands under `library/<project>/`, outside Git).

## 2. Metadata you add

| Field | Content |
|---|---|
| `tags` | ≤ 3 short lowercase labels used as filters (`baseline`, `regularizer`, `planning`) |
| `bibtexKey` | Optional; the key the report cites |
| status | `To read` → `Reading` → `Read`. Stay `To read` until you have read the paper itself, not only its abstract |

## 3. Body, in this order

1. `## TL;DR` — one sentence: `<Method> <does what> to <solve which problem>.` Define the method in plain words.
2. `## Why it matters here` — which of our claims or experiments it bears on, and how: a baseline we must run, work we build on, a competing explanation, or a result that contradicts ours. Name our records by *title in italics*, never by ID.
3. `## Method` — ≤ 5 bullets, only what we need to compare or reproduce.
4. `## Reported results` — the numbers we would cite, each with its source (`Table 2`, `~ read from Figure 3`), units and aggregation. A value you could not find is written as unknown.
5. `## Reproduction notes` (optional) — code availability; whether data, splits, horizon, metric and budget match our protocol; what a faithful adaptation needs. Label toy adaptations as adaptations, never as exact reproductions.
6. `## Limits` — what the paper does not show.

If you summarised from the abstract only, say `(from the abstract)` at the end of the TL;DR.

## 4. Links from the Paper

| Relation | Target | Meaning |
|---|---|---|
| `baseline` | Experiment | The paper's method is an arm of that experiment |
| `compares_with` | Experiment | Its results are compared with ours, without running it |
| `builds_on` | Idea or Claim | Our idea or claim extends this work |
| `supports` / `refutes` | Claim | External evidence for or against our claim; it does not set our verdict |
| `cites` | Any | Background only |

These are the relation names offered by the record's **Add link** menu.

## 5. Importing related work (skill)

Use this when the researcher says "import the related work", "add the papers from the report", or pastes a reading list.

1. **Import in one call.** `research_import_papers` with `fromReport: true` (every `.bib` in the project's Overleaf clone), `bibtex` (pasted entries), and/or `urls` (arXiv or paper links). CLI: `research papers-import PROJECT --from-report` / `--bib FILE` / `URL…`. arXiv entries get title, authors, abstract and BibTeX from arXiv; other entries keep their own BibTeX and `bibtexKey`. arXiv ids are also found in Google Scholar style `journal`/`note` fields (`arXiv preprint arXiv:2411.04983`). A paper already in the project (same arXiv id or link, BibTeX key, or title) is skipped with its record id, and gets the report's `bibtexKey` if it had none. With an arXiv id, the record takes arXiv's title and authors; a BibTeX title that differs is returned under `warnings` (check that the id belongs to the entry). An entry with unclosed braces fails alone, by its key; DOI-only links need a title or the BibTeX entry. Nothing is linked or summarised yet.
2. **Report what happened** to the researcher: created, skipped (duplicates), failed (and why).
3. **Triage before writing.** Ask, or infer from the project's claims, which papers matter now. Write full notes only for those; leave the rest `To read`.
4. **For each paper you write up:** `research_get` it, read its abstract (and the PDF if attached), then `research_update` its body with `## TL;DR` and `## Why it matters here` (add `(from the abstract)` if you did not read the paper), set `metadata.tags`, and link it (`patch.addLinks`) (section 4) to the claim or experiment it bears on. Add `## Reported results` only with table or figure sources.
5. **Check:** `research_lint` reports `paper-no-relevance` and `paper-unlinked` for papers still missing a write-up or a link.

## 6. Self-check

- [ ] Created with `research_add_paper`; status matches what you actually read.
- [ ] The PDF is stored (`metadata.pdf`), and the code was checked: `metadata.codeSearch.result` is `found`, `confirmed` or `none` with a reason — never left `unconfirmed`.
- [ ] TL;DR is one sentence and defines the method.
- [ ] `## Why it matters here` names at least one of our claims or experiments, and the paper links to it.
- [ ] Every reported number has a table or figure source; plot readings use `~`.
- [ ] No record IDs in prose; abbreviations defined.
