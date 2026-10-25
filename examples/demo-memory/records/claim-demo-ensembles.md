---
id: claim-demo-ensembles
kind: Claim
title: Critic ensembles explain the gain
projectIds:
  - project-demo
status: Refuted
revision: 3
createdAt: 2026-10-25T23:43:41.875Z
updatedAt: 2026-10-25T23:43:42.337Z
links: []
sources: []
metadata:
  answer: "No: ensembles alone add 1 point"
  conditions: 3 tasks, 5 seeds
  author: human
  needsReview: false
  reviewReason: ""
  review:
    status: Refuted
    reason: Ensembles add 1 point; the chunked critic adds 11.
    evidenceVersions: {}
    at: 2026-10-25T23:43:42.274Z
    by: human
  backBurner:
    active: true
    reason: Refuted; the distilled-critic claim replaces it.
    category: superseded
    supersededBy: claim-demo-distilled
    at: 2026-10-25T23:43:42.337Z
    by: human
    previousStatus: Refuted
---

## Statement
The gain comes from critic ensembling, not from chunking.

## Evidence
- *Do critic ensembles explain the gain?* — 64% vs 63%.

## Limits
Superseded by the distilled-critic claim.
