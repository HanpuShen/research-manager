#!/usr/bin/env bash
set -euo pipefail
research_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$research_root"
mkdir -p .tools/bin .tools/npm
if [ ! -x .tools/bin/node ]; then
  research_arch="$(uname -m)"
  case "$research_arch" in x86_64) research_arch=x64;; aarch64) research_arch=arm64;; *) echo 'Unsupported architecture' >&2; exit 1;; esac
  research_archive="node-v24.15.0-linux-$research_arch.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v24.15.0/$research_archive" -o ".tools/$research_archive"
  curl -fsSL https://nodejs.org/dist/v24.15.0/SHASUMS256.txt -o .tools/SHASUMS256.txt
  (cd .tools && awk -v file="$research_archive" '$2 == file' SHASUMS256.txt | sha256sum -c -)
  tar -xf ".tools/$research_archive" -C .tools
  cp ".tools/node-v24.15.0-linux-$research_arch/bin/node" .tools/bin/node
fi
if [ ! -f .tools/npm/package/bin/npm-cli.js ]; then
  curl -fsSL https://registry.npmjs.org/npm/-/npm-11.6.2.tgz -o .tools/npm/npm.tgz
  tar -xzf .tools/npm/npm.tgz -C .tools/npm
fi
ln -sf ../npm/package/bin/npm-cli.js .tools/bin/npm
ln -sf ../npm/package/bin/npx-cli.js .tools/bin/npx
export PATH="$research_root/.tools/bin:$PATH"
npm ci --no-audit --no-fund
npm run build
