// Builds examples/demo-memory: a small synthetic project used by the README screenshots and for trying the app.
// Usage: npx tsx scripts/demo/build-demo-memory.ts [OUT_DIR]. Papers are fetched from arXiv (metadata only, no PDFs).
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { ResearchStore } from '../../src/store.js';
import { ResearchService } from '../../src/service.js';

const out = path.resolve(process.argv[2] ?? 'examples/demo-memory');
const P = 'project-demo';
const human = (e: { revision: number; contentHash?: string }) => ({ expectedRevision: e.revision, expectedHash: e.contentHash!, actor: 'human' as const });

async function main() {
  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(path.join(out, 'figures'), { recursive: true });
  execFileSync(process.env.DEMO_PYTHON ?? 'python3', [path.join(__dirname, 'figures.py'), path.join(out, 'figures')], { stdio: 'inherit' });
  const store = await new ResearchStore(out, path.join(os.tmpdir(), `research-demo-cache-${process.pid}`)).init();
  const service = new ResearchService(store);
  const c = (record: Parameters<ResearchStore['create']>[0]) => store.create({ projectIds: [P], ...record }, 'human');

  await c({ kind: 'Project', id: P, projectIds: [], title: 'Demo: Chunked critics (synthetic data)', status: 'Active', body: `A demo project with synthetic data. Chunked critics score short sequences of $K$ actions instead of single actions, so value backups skip intermediate states.

## Question
Can critics over action chunks raise offline RL success on long-horizon manipulation?

## Why it is hard
Longer chunks shorten the backup horizon but enlarge the action space, so the critic generalizes worse. Single-step critics are easy to fit but compound value error over long horizons.

## Key idea
Score chunks of $K$ actions with a critic distilled from a single-step critic, so the chunk value stays grounded while each backup skips $K$ steps.

## Current answer
Partly. Chunked critics reach 74% vs 63% mean success over 5 tasks, but removing the distilled critic costs more than 10 points on only 1 of 3 tasks, and chunk length beyond $K = 8$ is untested.

## Next decision
Run the chunk-length sweep ($K = 1$–$16$) before claiming where chunking stops helping.` });

  const claim = (id: string, title: string, answer: string, conditions: string, body: string, links: { target: string; relation: string }[] = []) =>
    c({ kind: 'Claim', id, title, body, links, metadata: { answer, conditions } });
  let c1 = await claim('claim-demo-chunks-win', '1. Chunked critics win on 3 of 5 tasks', '74% vs 63% mean success over 5 tasks', '5 simulated manipulation tasks, 5 seeds, 1M gradient steps',
    '## Statement\nA critic over 4-action chunks beats a single-step critic on 3 of 5 tasks.\n\n## Why this step\nIt is the premise: chunking must help before we ask why.\n\n## Evidence\n- *Do chunked critics beat single-step critics?* — 74% vs 63% mean success.\n\n## Limits\nSynthetic demo data; one dataset size.',
    [{ target: 'experiment-demo-main', relation: 'evidence' }, { target: 'claim-demo-distilled', relation: 'next_question' }]);
  await claim('claim-demo-distilled', '2. The distilled critic carries the gain', 'Partly: −12 points on 1 of 3 tasks without it', '3 tasks, 5 seeds',
    '## Statement\nRemoving the distilled critic removes most of the chunking gain.\n\n## Why this step\nIt separates the mechanism (grounded chunk values) from the chunking itself.\n\n## Evidence\n- *Is the distilled critic needed?* — 78% vs 66% on long-reach; within 1 point elsewhere.\n\n## Limits\nOnly three tasks.',
    [{ target: 'experiment-demo-ablation', relation: 'evidence' }, { target: 'claim-demo-length', relation: 'next_question' }]);
  await claim('claim-demo-length', '3. Gains stop beyond K = 8', 'Not tested yet — the K = 1–16 sweep decides it', 'planned: 3 tasks, K = 1, 2, 4, 8, 16',
    '## Statement\nSuccess rises with chunk length up to $K = 8$ and falls beyond it.\n\n## Why this step\nIt tells us where the trade-off between backup horizon and action-space size turns.\n\n## Evidence\n- *Where does chunk length stop helping?* — not run yet.\n\n## Limits\nNot tested.',
    [{ target: 'experiment-demo-sweep', relation: 'evidence' }]);
  let c4 = await claim('claim-demo-ensembles', 'Critic ensembles explain the gain', 'No: ensembles alone add 1 point', '3 tasks, 5 seeds',
    '## Statement\nThe gain comes from critic ensembling, not from chunking.\n\n## Evidence\n- *Do critic ensembles explain the gain?* — 64% vs 63%.\n\n## Limits\nSuperseded by the distilled-critic claim.');

  const experiment = (id: string, title: string, status: string, tests: string, body: string, links: { target: string; relation: string }[] = []) =>
    c({ kind: 'Experiment', id, title, status, body, links: [{ target: tests, relation: 'tests' }, ...links], metadata: { experimentType: 'confirmation' } });
  await experiment('experiment-demo-main', 'Do chunked critics beat single-step critics?', 'Completed', c1.id, `## Question
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
Rule met: yes — ahead on 3 of 5 tasks; 74% vs 63% mean success.`, [{ target: 'artifact-demo-figures', relation: 'produced' }]);
  await experiment('experiment-demo-ablation', 'Is the distilled critic needed?', 'Completed', 'claim-demo-distilled', `## Question
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
Rule met: partly — −12 points on long-reach, within 1 point on the other two tasks.`, [{ target: 'experiment-demo-main', relation: 'child_of' }, { target: 'artifact-demo-figures', relation: 'produced' }]);
  await experiment('experiment-demo-sweep', 'Where does chunk length stop helping?', 'Planned', 'claim-demo-length', `## Question
How does success change with chunk length $K \\in \\{1, 2, 4, 8, 16\\}$ on three tasks?

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
Not run yet.`);
  await experiment('experiment-demo-ensembles', 'Do critic ensembles explain the gain?', 'Completed', c4.id, `## Question
Does an ensemble of single-step critics match the chunked critic?

## Decision rule
Supports the ensemble explanation if the ensemble is within 3 points of the chunked critic on 3 tasks.

## Result
Rule met: no — 64% vs 63% for the single-step critic, 74% for the chunked critic.`);

  await c({ kind: 'Artifact', id: 'artifact-demo-figures', title: 'Chunked critic figures', status: 'Available', body: 'Learning curves and the ablation (synthetic demo data).',
    sources: [{ path: '../figures/figure-inventory.json', label: 'Figure inventory' }], links: [{ target: 'experiment-demo-main', relation: 'produced_by' }] });
  await c({ kind: 'Note', id: 'note-demo-main-observation', title: 'Observation: chunked vs single-step critic', status: 'Active', metadata: { role: 'Observation' },
    links: [{ target: 'experiment-demo-main', relation: 'discusses' }, { target: c1.id, relation: 'evidence' }], body: `## Main finding
The chunked critic is ahead on 3 of 5 tasks (74% vs 63% mean success); the gap is largest on long-reach (+18 points) and small on slide-door (+3), so chunking helps most where horizons are longest.

## Measured results
Final success (%), mean of 5 seeds, ± 1 SD across seeds; synthetic demo data in \`figures/main-curves.png\`.

| Task | Chunked | Single-step |
|---|---|---|
| long-reach | **78 ± 3** | 60 ± 3 |
| two-stack | **71 ± 2** | 62 ± 3 |
| slide-door | 69 ± 3 | 66 ± 2 |

Omitted: two further tasks.

## Limits
One dataset size and one chunk length ($K = 4$).` });
  await c({ kind: 'Note', id: 'note-demo-ablation-observation', title: 'Observation: distilled critic ablation', status: 'Active', metadata: { role: 'Observation' },
    links: [{ target: 'experiment-demo-ablation', relation: 'discusses' }, { target: 'claim-demo-distilled', relation: 'evidence' }], body: `## Main finding
Without the distilled critic, long-reach drops from 78% to 66%, while two-stack and slide-door stay within 1 point, so grounding matters on the longest-horizon task only.

## Measured results
Final success (%), mean of 5 seeds; \`figures/ablation-bars.png\`.

| Task | With | Without |
|---|---|---|
| long-reach | **78** | 66 |
| two-stack | 71 | 70 |
| slide-door | 69 | 68 |

## Limits
Three tasks; one chunk length.` });
  await c({ kind: 'Note', id: 'note-demo-interpretation', title: 'Why grounding matters on long horizons', status: 'Active', metadata: { role: 'Interpretation' },
    links: [{ target: 'claim-demo-distilled', relation: 'discusses' }], body: '## Explanation\nLong-horizon tasks accumulate more value error per backup, so ungrounded chunk values drift more.\n\n## Evidence for and against\nFor: the drop is largest on long-reach. Against: only three tasks.\n\n## Status\nUntested; the chunk-length sweep would test it.' });
  await c({ kind: 'Idea', id: 'idea-demo-adaptive-k', title: 'Adaptive chunk length per state', status: 'Inbox', body: '## Question\nCould the policy choose $K$ per state instead of a fixed chunk length?\n\n## Motivation\nThe ablation suggests long-horizon states benefit most from chunking.' });
  await c({ kind: 'Note', id: 'note-demo-handoff', title: 'Handoff: chunk-length sweep is next', status: 'Active', metadata: { role: 'Handoff' },
    links: [{ target: 'experiment-demo-sweep', relation: 'discusses' }, { target: 'claim-demo-distilled', relation: 'discusses' }], body: `## Goal
Decide where chunking stops helping.

## Current state
Claim 1 is supported. Claim 2 has an agent proposal (Mixed) waiting for review. The sweep is planned, not submitted.

## Next steps
1. Review the proposal on claim 2.
2. Submit the K = 1–16 sweep after the brief is approved.` });

  // Human review, an agent proposal waiting for review, and a refuted claim moved to the back burner.
  c1 = await store.reviewClaim(c1.id, 'Supported', 'The decision rule was met on 3 of 5 tasks.', human(c1));
  await store.proposeVerdict('claim-demo-distilled', 'Mixed', 'Rule met: partly — −12 points on long-reach, within 1 point on two-stack and slide-door.');
  c4 = await store.reviewClaim(c4.id, 'Refuted', 'Ensembles add 1 point; the chunked critic adds 11.', human(c4));
  await store.setBackBurner(c4.id, true, 'Refuted; the distilled-critic claim replaces it.', human(c4), { category: 'superseded', supersededBy: 'claim-demo-distilled' });

  for (const [paper, notes, link] of [
    ['2110.06169', '## TL;DR\nImplicit Q-Learning fits values with expectile regression, avoiding queries of unseen actions.\n\n## Why it matters here\nIt is the single-step critic baseline in *Do chunked critics beat single-step critics?*.', { target: 'experiment-demo-main', relation: 'baseline' }],
    ['2310.16828', '## TL;DR\nTD-MPC2 learns a latent world model and plans with it across many continuous-control tasks.\n\n## Why it matters here\nA model-based alternative for long horizons; we compare with it rather than run it.', { target: 'experiment-demo-main', relation: 'compares_with' }],
    ['2106.01345', '## TL;DR\nDecision Transformer casts offline RL as sequence modelling conditioned on return.\n\n## Why it matters here\nIt predicts action sequences without a critic, the opposite design choice to ours.', { target: 'claim-demo-chunks-win', relation: 'cites' }],
  ] as const) {
    const { paper: added } = await service.collectPaper({ projectId: P, paper, notes, pdf: false }, 'human');
    const status = paper === '2110.06169' ? 'Read' : 'Reading';
    await store.update(added.id, { status, links: [link] }, human(added));
  }

  const project = store.get(P);
  await store.update(P, { metadata: { ...project.metadata, researchFlow: { version: 1, handoffId: 'note-demo-handoff',
    overviewNodeIds: ['claim-demo-chunks-win', 'claim-demo-distilled', 'claim-demo-length'],
    nodeIds: ['claim-demo-chunks-win', 'claim-demo-distilled', 'claim-demo-length', 'experiment-demo-main', 'experiment-demo-ablation', 'experiment-demo-sweep', 'claim-demo-ensembles', 'experiment-demo-ensembles'],
    edges: [
      { source: P, target: 'claim-demo-chunks-win', label: 'Question' },
      { source: 'claim-demo-chunks-win', target: 'claim-demo-distilled', label: 'why it works' },
      { source: 'claim-demo-distilled', target: 'claim-demo-length', label: 'how far' },
      { source: 'claim-demo-chunks-win', target: 'experiment-demo-main', label: 'Test: vs single-step' },
      { source: 'claim-demo-distilled', target: 'experiment-demo-ablation', label: 'Test: drop distillation' },
      { source: 'experiment-demo-main', target: 'experiment-demo-ablation', label: 'Child: no distillation' },
      { source: 'claim-demo-length', target: 'experiment-demo-sweep', label: 'Test: K = 1–16' },
    ] } } }, human(project));
  await fs.writeFile(path.join(out, 'readme.md'), '# Demo memory\n\nA small synthetic research project for trying Research Manager and for the README screenshots. All numbers and figures are synthetic. Paper records hold arXiv metadata only (no PDFs).\n\nTry it: `RESEARCH_MEMORY_ROOT=examples/demo-memory npm run preview`, or point the extension\'s memory folder here. Rebuild with `npx tsx scripts/demo/build-demo-memory.ts` (needs Python with matplotlib and network access to arXiv).\n');
  store.close();
  await fs.rm(path.join(out, 'history'), { recursive: true, force: true }); // revision history of the build itself is noise here
  console.log('demo memory written to', out);
}

main().catch(error => { console.error(error); process.exit(1); });
