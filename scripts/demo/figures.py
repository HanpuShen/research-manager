"""Synthetic figures for the demo memory (no real experiment data). Usage: python figures.py OUT_DIR"""
import json, sys, pathlib
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
rng = np.random.default_rng(0)
plt.rcParams.update({"figure.dpi": 150, "font.size": 9, "axes.spines.top": False, "axes.spines.right": False})
steps = np.linspace(0, 1, 60)

fig, axes = plt.subplots(1, 3, figsize=(8.4, 2.6), sharey=True)
for ax, (task, gain), base in zip(axes, [("long-reach", 0.18), ("two-stack", 0.09), ("slide-door", 0.03)], [0.60, 0.62, 0.66]):
    for name, color, final in [("chunked critic", "#2a7de1", base + gain), ("single-step critic", "#9aa3ad", base)]:
        mean = final * (1 - np.exp(-4 * steps)) + rng.normal(0, 0.008, steps.size)
        ax.plot(steps * 1e6, mean * 100, color=color, label=name, lw=1.6)
        ax.fill_between(steps * 1e6, (mean - 0.03) * 100, (mean + 0.03) * 100, color=color, alpha=0.15, lw=0)
    ax.set_title(task); ax.set_xlabel("gradient steps")
axes[0].set_ylabel("success (%)"); axes[0].legend(frameon=False, loc="lower right")
fig.suptitle("Synthetic demo data", fontsize=8, color="#888", x=0.99, ha="right")
fig.tight_layout(); fig.savefig(out / "main-curves.png"); plt.close(fig)

fig, ax = plt.subplots(figsize=(4.2, 2.6))
tasks = ["long-reach", "two-stack", "slide-door"]
full, ablated = [78, 71, 69], [66, 70, 68]
x = np.arange(3)
ax.bar(x - 0.18, full, 0.36, color="#2a7de1", label="with distilled critic")
ax.bar(x + 0.18, ablated, 0.36, color="#9aa3ad", label="without")
ax.set_xticks(x, tasks); ax.set_ylabel("final success (%)"); ax.set_ylim(50, 85); ax.legend(frameon=False)
fig.suptitle("Synthetic demo data", fontsize=8, color="#888", x=0.99, ha="right")
fig.tight_layout(); fig.savefig(out / "ablation-bars.png"); plt.close(fig)

json.dump([
  {"name": "main-curves", "title": "Learning curves: chunked vs single-step critic", "kind": "result",
   "caption": "Mean success over 5 seeds on three of the five tasks; bands are ±1 SD across seeds.",
   "readingGuide": "x: gradient steps; y: success in %. Blue is the chunked critic, grey the single-step critic. Compare the right end of each panel: the gap is large on long-reach, small on slide-door.",
   "artifacts": [{"path": "main-curves.png"}]},
  {"name": "ablation-bars", "title": "Ablation: removing the distilled critic", "kind": "result",
   "caption": "Final success (%), mean of 5 seeds.",
   "readingGuide": "Compare each blue bar with the grey bar to its right. Only long-reach loses more than 10 points without the distilled critic.",
   "artifacts": [{"path": "ablation-bars.png"}]},
], open(out / "figure-inventory.json", "w"), indent=2)
print("figures written to", out)
