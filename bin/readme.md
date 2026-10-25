# Command launcher

`research` launches `../dist/cli.cjs` with Node 24+. It prefers `RESEARCH_NODE`, then the private `../.tools/bin/node`, then an adequate Node on PATH. It never upgrades system Node.
