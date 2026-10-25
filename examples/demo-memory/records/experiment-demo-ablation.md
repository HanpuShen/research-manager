---
id: experiment-demo-ablation
kind: Experiment
title: Is the distilled critic needed?
projectIds:
  - project-demo
status: Completed
revision: 1
createdAt: 2026-10-25T23:43:41.924Z
updatedAt: 2026-10-25T23:43:41.924Z
links:
  - target: claim-demo-distilled
    relation: tests
  - target: experiment-demo-main
    relation: child_of
  - target: artifact-demo-figures
    relation: produced
sources: []
metadata:
  experimentType: confirmation
  author: human
---

## Question
Does removing the distilled critic remove the chunking gain on long-reach, two-stack and slide-door?

## Why this comparison
If chunking alone carried the gain, the ablation would match the full method.

## Placement
Tests claim 2. Child of *Do chunked critics beat single-step critics?*; only the distilled critic changes.

## Setup and controls
| Arm | What it isolates |
|---|---|
| full method | — |
| without distilled critic | grounding of chunk values |

3 tasks, 5 seeds, final success in %.

## Decision rule
Supports claim 2 if removing the distilled critic costs more than 10 points on at least 2 of 3 tasks.

## Result
Rule met: partly — −12 points on long-reach, within 1 point on the other two tasks.
