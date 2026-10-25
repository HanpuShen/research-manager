# Research Manager development

Read README.md, docs/user-guide.md, and docs/guides/agent-guide.md. Use the private Node 24 toolchain in .tools/bin; the system Node is too old. Keep shared interfaces in src/types.ts stable across the extension, CLI/MCP, and webview. Never run real research jobs as a software test. Use temporary memory folders and fake schedulers; preserve current research repositories and their experiments. Run check, build, and relevant tests before packaging.
