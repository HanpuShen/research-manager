---
id: experiment-demo-sweep
kind: Experiment
title: Where does chunk length stop helping?
projectIds:
  - project-demo
status: Planned
revision: 1
createdAt: 2026-10-25T23:43:41.951Z
updatedAt: 2026-10-25T23:43:41.951Z
links:
  - target: claim-demo-length
    relation: tests
sources: []
metadata:
  experimentType: confirmation
  author: human
---

## Question
How does success change with chunk length $K \in \{1, 2, 4, 8, 16\}$ on three tasks?

## Why this comparison
It locates the turning point of the horizon/action-space trade-off.

## Placement
Tests claim 3. Sibling of the main comparison: same tasks, chunk length varies.

## Setup and controls
| Arm | What it isolates |
|---|---|
| $K = 1$ | single-step baseline |
| $K = 2, 4, 8, 16$ | chunk length |

3 tasks, 5 seeds, success in %.

## Decision rule
Supports claim 3 if success at $K = 16$ is more than 5 points below $K = 8$ on at least 2 of 3 tasks.

## Result
Not run yet.
