---
id: claim-demo-chunks-win
kind: Claim
title: 1. Chunked critics win on 3 of 5 tasks
projectIds:
  - project-demo
status: Supported
revision: 2
createdAt: 2026-10-25T23:43:41.798Z
updatedAt: 2026-10-25T23:43:42.198Z
links:
  - target: experiment-demo-main
    relation: evidence
  - target: claim-demo-distilled
    relation: next_question
sources: []
metadata:
  answer: 74% vs 63% mean success over 5 tasks
  conditions: 5 simulated manipulation tasks, 5 seeds, 1M gradient steps
  author: human
  needsReview: false
  reviewReason: ""
  review:
    status: Supported
    reason: The decision rule was met on 3 of 5 tasks.
    evidenceVersions:
      artifact-demo-figures: ee0fc9d10837acd0b61e8ee1bbd1b9f294fea6483a879ab2676f22d7bd30f4bb
    at: 2026-10-25T23:43:42.184Z
    by: human
---

## Statement
A critic over 4-action chunks beats a single-step critic on 3 of 5 tasks.

## Why this step
It is the premise: chunking must help before we ask why.

## Evidence
- *Do chunked critics beat single-step critics?* — 74% vs 63% mean success.

## Limits
Synthetic demo data; one dataset size.
