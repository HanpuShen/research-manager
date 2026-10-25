# Behavior tests

Tests below the software root validate memory concurrency and provenance, public CLI/MCP compatibility, safe Report/Drive adapters, source maps, and isolated experiment workers. Use temporary repositories and fake schedulers. No test submits a GPU experiment or pushes a real document.

`back-burner.test.ts` checks placement persistence, concurrent edits, legacy Parked records, evidence/run preservation, and CLI/MCP round trips. `back-burner-map.test.ts` checks that current maps hide shelved branches without losing shared or historical evidence.

`service-performance.test.ts` verifies cached navigation during blocked background reads, explicit freshness, source/report scoping, preserved conflict checks, and project context across queued actions and Drive sign-in. `graph-layout.test.ts` checks geometry cache reuse, topology invalidation, and its size bound. The real host smoke includes navigation while the mutation queue is blocked and rejects actions targeting a project that is no longer selected.

`previews.test.ts` covers linked evidence, local image resolution, CSV quoting, bounded files, and missing or disallowed paths. The real host smoke verifies the packaged preview bridge returns image bytes and table cells without changing navigation. `scripts/experiment-preview-audit.mjs` checks rendered setup/results, figures, tables, themes, and stale response handling using disposable records.

`review.test.ts` checks sourced review extraction, counterexample preservation, operational/planned section exclusion, and invalid-evidence handling.
