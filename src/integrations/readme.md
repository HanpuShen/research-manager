# Integrations

`src/integrations/` connects workspace source, report Git clones, and Drive metadata to Research Manager.

- `code-map.ts`: Python AST parsing in an isolated Python 3 process, shell entrypoint detection, and local import/call graphs. Source is read, never imported or executed. Graph revisions hash current source contents, including uncommitted files.
- `report.ts`: status, clean fast-forward synchronization, and an explicit publish operation. Git runs without a shell or interactive credential prompt; failed fetches and diverged histories preserve local content.
- `drive.ts`: Desktop OAuth PKCE helpers and Drive metadata browsing. The extension injects SecretStorage token access and handles the loopback listener and forwarded port. Listings include shared drives, pagination, recursive children, partial failures, and an in-memory cache of complete metadata listings. No tokens enter that cache.

Source links carry absolute paths, symbols, line numbers, and graph revision. Algorithm links are marked inferred and should be reviewed when the source revision changes. Generic Python data views show resolvable calls, not runtime data provenance. Python syntax errors remain visible in the module view.

Hand-written algorithm descriptions, when added, must be tied to reviewed SHA-256 source fingerprints so that changed source keeps a Needs review warning; refreshing the diagram only updates source locationss. Modules and generic static calls are rebuilt directly from current syntax.

The reviewed file fingerprint is exposed as `SourceRef.reviewedHash`, separate from the current graph revision. The webview keeps these identifiers under Source details so they remain available without interrupting the algorithm explanation.

OAuth requires a Google Cloud Desktop client with the Drive API enabled and the `drive.metadata.readonly` scope. A Desktop client secret may be supplied if required by the client's configuration. Remote SSH must forward the callback to a local HTTP loopback port. Drive returns metadata only; file contents remain online. Directory shortcuts are listed but not followed outside the selected folder.

References: [Google Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app), [Drive search](https://developers.google.com/workspace/drive/api/guides/search-files), [shared drives](https://developers.google.com/workspace/drive/api/guides/enable-shareddrives).

Behavioral tests live in `tests/integrations.test.ts`; they use temporary local Git remotes and injected HTTP responses and never contact Overleaf or Google.
