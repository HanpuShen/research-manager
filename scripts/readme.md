# Development tools

Relative to the software root: `bootstrap.sh` installs a private Node 24 toolchain into `../.tools/` and builds; `build.mjs` bundles the extension, CLI and webview into `../dist/`; `preview.mjs` serves the real webview in a browser (`RESEARCH_MEMORY_ROOT=… npm run preview`, port 4317). Screenshots and reports belong in the ignored `../test-results/`; use disposable memory copies for anything that writes.

`extension-smoke.mjs` launches a real VS Code extension host against temporary memory. On a headless host, run it with `xvfb-run`.

`related-work-smoke.mjs` checks the Related work page in a browser against a copy of the memory folder named by `RESEARCH_MEMORY_ROOT`.

`demo/` builds the synthetic demo memory (`build-demo-memory.ts`, `figures.py`) and captures the README and product-page screenshots (`screenshots.mjs`).
