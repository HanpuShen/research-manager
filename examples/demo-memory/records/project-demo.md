---
id: project-demo
kind: Project
title: "Demo: Chunked critics (synthetic data)"
projectIds: []
status: Active
revision: 2
createdAt: 2026-10-25T23:43:41.763Z
updatedAt: 2026-10-25T23:43:43.787Z
links: []
sources: []
metadata:
  author: human
  researchFlow:
    version: 1
    handoffId: note-demo-handoff
    overviewNodeIds:
      - claim-demo-chunks-win
      - claim-demo-distilled
      - claim-demo-length
    nodeIds:
      - claim-demo-chunks-win
      - claim-demo-distilled
      - claim-demo-length
      - experiment-demo-main
      - experiment-demo-ablation
      - experiment-demo-sweep
      - claim-demo-ensembles
      - experiment-demo-ensembles
    edges:
      - source: project-demo
        target: claim-demo-chunks-win
        label: Question
      - source: claim-demo-chunks-win
        target: claim-demo-distilled
        label: why it works
      - source: claim-demo-distilled
        target: claim-demo-length
        label: how far
      - source: claim-demo-chunks-win
        target: experiment-demo-main
        label: "Test: vs single-step"
      - source: claim-demo-distilled
        target: experiment-demo-ablation
        label: "Test: drop distillation"
      - source: experiment-demo-main
        target: experiment-demo-ablation
        label: "Child: no distillation"
      - source: claim-demo-length
        target: experiment-demo-sweep
        label: "Test: K = 1–16"
---

A demo project with synthetic data. Chunked critics score short sequences of $K$ actions instead of single actions, so value backups skip intermediate states.

## Question
Can critics over action chunks raise offline RL success on long-horizon manipulation?

## Why it is hard
Longer chunks shorten the backup horizon but enlarge the action space, so the critic generalizes worse. Single-step critics are easy to fit but compound value error over long horizons.

## Key idea
Score chunks of $K$ actions with a critic distilled from a single-step critic, so the chunk value stays grounded while each backup skips $K$ steps.

## Current answer
Partly. Chunked critics reach 74% vs 63% mean success over 5 tasks, but removing the distilled critic costs more than 10 points on only 1 of 3 tasks, and chunk length beyond $K = 8$ is untested.

## Next decision
Run the chunk-length sweep ($K = 1$–$16$) before claiming where chunking stops helping.
