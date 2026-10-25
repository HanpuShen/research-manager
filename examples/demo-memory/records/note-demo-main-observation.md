---
id: note-demo-main-observation
kind: Note
title: "Observation: chunked vs single-step critic"
projectIds:
  - project-demo
status: Active
revision: 1
createdAt: 2026-10-25T23:43:42.032Z
updatedAt: 2026-10-25T23:43:42.032Z
links:
  - target: experiment-demo-main
    relation: discusses
  - target: claim-demo-chunks-win
    relation: evidence
sources: []
metadata:
  role: Observation
  author: human
---

## Main finding
The chunked critic is ahead on 3 of 5 tasks (74% vs 63% mean success); the gap is largest on long-reach (+18 points) and small on slide-door (+3), so chunking helps most where horizons are longest.

## Measured results
Final success (%), mean of 5 seeds, ± 1 SD across seeds; synthetic demo data in `figures/main-curves.png`.

| Task | Chunked | Single-step |
|---|---|---|
| long-reach | **78 ± 3** | 60 ± 3 |
| two-stack | **71 ± 2** | 62 ± 3 |
| slide-door | 69 ± 3 | 66 ± 2 |

Omitted: two further tasks.

## Limits
One dataset size and one chunk length ($K = 4$).
