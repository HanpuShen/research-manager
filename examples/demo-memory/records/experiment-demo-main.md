---
id: experiment-demo-main
kind: Experiment
title: Do chunked critics beat single-step critics?
projectIds:
  - project-demo
status: Completed
revision: 1
createdAt: 2026-10-25T23:43:41.901Z
updatedAt: 2026-10-25T23:43:41.901Z
links:
  - target: claim-demo-chunks-win
    relation: tests
  - target: artifact-demo-figures
    relation: produced
sources: []
metadata:
  experimentType: confirmation
  author: human
---

## Question
Does a critic over 4-action chunks raise success over a single-step critic on 5 simulated manipulation tasks?

## Why this comparison
It rules out that the gain comes from more gradient steps: both critics use the same data, budget and policy extraction.

## Placement
Tests claim 1. Root experiment of this project.

## Setup and controls
| Arm | What it isolates |
|---|---|
| chunked critic ($K = 4$) | chunked backups |
| single-step critic | baseline |

5 tasks, 5 seeds, 1M gradient steps, success in %, mean over seeds; ± is 1 SD across seeds.

## Decision rule
Supports claim 1 if the chunked critic is ahead by more than 5 points on at least 3 of 5 tasks.

## Result
Rule met: yes — ahead on 3 of 5 tasks; 74% vs 63% mean success.
