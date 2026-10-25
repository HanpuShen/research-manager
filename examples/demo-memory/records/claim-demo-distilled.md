---
id: claim-demo-distilled
kind: Claim
title: 2. The distilled critic carries the gain
projectIds:
  - project-demo
status: Open
revision: 1
createdAt: 2026-10-25T23:43:41.824Z
updatedAt: 2026-10-25T23:43:41.824Z
links:
  - target: experiment-demo-ablation
    relation: evidence
  - target: claim-demo-length
    relation: next_question
sources: []
metadata:
  answer: "Partly: −12 points on 1 of 3 tasks without it"
  conditions: 3 tasks, 5 seeds
  author: human
---

## Statement
Removing the distilled critic removes most of the chunking gain.

## Why this step
It separates the mechanism (grounded chunk values) from the chunking itself.

## Evidence
- *Is the distilled critic needed?* — 78% vs 66% on long-reach; within 1 point elsewhere.

## Limits
Only three tasks.
