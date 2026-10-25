---
id: note-demo-ablation-observation
kind: Note
title: "Observation: distilled critic ablation"
projectIds:
  - project-demo
status: Active
revision: 1
createdAt: 2026-10-25T23:43:42.060Z
updatedAt: 2026-10-25T23:43:42.060Z
links:
  - target: experiment-demo-ablation
    relation: discusses
  - target: claim-demo-distilled
    relation: evidence
sources: []
metadata:
  role: Observation
  author: human
---

## Main finding
Without the distilled critic, long-reach drops from 78% to 66%, while two-stack and slide-door stay within 1 point, so grounding matters on the longest-horizon task only.

## Measured results
Final success (%), mean of 5 seeds; `figures/ablation-bars.png`.

| Task | With | Without |
|---|---|---|
| long-reach | **78** | 66 |
| two-stack | 71 | 70 |
| slide-door | 69 | 68 |

## Limits
Three tasks; one chunk length.
