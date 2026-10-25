---
id: experiment-demo-ensembles
kind: Experiment
title: Do critic ensembles explain the gain?
projectIds:
  - project-demo
status: Completed
revision: 1
createdAt: 2026-10-25T23:43:41.978Z
updatedAt: 2026-10-25T23:43:41.978Z
links:
  - target: claim-demo-ensembles
    relation: tests
sources: []
metadata:
  experimentType: confirmation
  author: human
---

## Question
Does an ensemble of single-step critics match the chunked critic?

## Decision rule
Supports the ensemble explanation if the ensemble is within 3 points of the chunked critic on 3 tasks.

## Result
Rule met: no — 64% vs 63% for the single-step critic, 74% for the chunked critic.
