# Neo Archive setup evidence

The initial Neotask adaptation uses the inherited TypeScript backend and SQLite. A Rust backend/search evaluation is open; no Rust rewrite or XF code import has been performed.

The fork changes the app/CLI name, data root, environment variables, job labels, request identity, and developer skill. The upstream license and history remain intact. The runtime is pinned locally; npm and upstream publication automation are not enabled for Neotask.

Explicit archive ownership (`import archive PATH --account HANDLE`) creates or reuses an account whose identity matches the archive. Account IDs scope collection edges, follow snapshots, and colliding DM IDs. Imports preserve the existing default account. Tweet search supports `--all-accounts` independently of the configured default. Read-only `db stats` includes the account inventory.

## Verification on September 7, 2026

- Format, lint, and TypeScript checks passed.
- Full Bun test suite with Istanbul coverage: 150 test files, 1,508 tests passed. Coverage: 89.18% statements, 79.82% branches, 90.39% functions, and 90.78% lines; all configured thresholds passed.
- Production CLI and web builds passed. The existing map bundle still produces Vite's size advisory.
- A separate installed-CLI check imported three synthetic archives, searched three bookmark and three like matches across accounts despite a configured default, and returned one match for a named account.
- Regression tests cover repeated imports, shared liked posts, distinct authored identities, colliding DM IDs, a scoped bookmark restore, and rejection of a mismatched owner before writes.
- Local installer checks passed for a fresh install, repeated install, three skill discovery links, and preservation of a conflicting command.
- Skill validation passed; authored setup/skill text was reviewed against the installed no-ai-slop evaluation.
- UBS found no critical or warning findings in the eight files implementing the account/search changes. Its wider scan of renamed inherited source/tests produced findings in inherited code requiring separate triage; that broad result is not a clean security audit. The local installer timeout advisory was corrected. Shared installer tests also cover missing skills and conflicting user overrides.

The archive remains local. No real X account has been imported or authenticated, and no recurring X sync job has been loaded. API access, per-account bookmark/like retrieval, and live pagination are unverified until account setup. Live DM fetching still depends on the private bird transport. Selected-author monitoring and Electron/gateway integration remain pending.
