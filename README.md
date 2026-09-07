# Neo Archive

Neo Archive keeps X archives, bookmarks, likes, posts, and imported messages in a local searchable SQLite database. It is Neotask's fork of [Peter Steinberger's Birdclaw](https://github.com/steipete/birdclaw), adapted for multiaccount research and the developer Flywheel.

The command is `neo-archive`. Local data lives in `~/.neo-archive`, and the agent skill is named `neo-archive`. This repository contains source code; account archives and credentials stay outside it.

## Local setup

Clone `NeotaskInc/neo-archive`, then run:

```sh
./scripts/bun-canary.sh install --frozen-lockfile
./scripts/bun-canary.sh run --bun build
python3 scripts/install-local.py
neo-archive --json init
```

The checked-in installer verifies and uses a project-local Bun runtime. It does not change the system Node or Bun default. Node users can use the version range in `package.json` and the `*:node` scripts. Neo Archive installs from source (`private: true` in package metadata); no npm release is configured.

The local installer exposes the CLI in `~/.local/bin` and the rewritten developer skill to Codex and Claude. It refuses to overwrite another installation. Add that bin directory to PATH if needed. The runtime and source checkout must remain available at their installed paths.

## Accounts and search

Import each account's downloaded X archive to establish its local identity:

```sh
neo-archive import archive /path/to/first-account-archive.zip --account FIRST_HANDLE
neo-archive import archive /path/to/second-account-archive.zip --account SECOND_HANDLE
neo-archive --json db stats
```

Use the [authentication guide](docs/auth.md) to register your X developer app with `xurl` and authorize each account. Confirm each selected identity before its first live sync. Archive import and live authentication are separate steps.

```sh
neo-archive sync bookmarks --account HANDLE --mode xurl --all
neo-archive sync likes --account HANDLE --mode xurl --all
neo-archive --json search tweets "agent tools" --bookmarked --all-accounts
neo-archive --json search tweets "agent tools" --liked --all-accounts
neo-archive --json search dms "agent tools"
```

`--all-accounts` overrides a configured default account for tweet search. Use `--account HANDLE` to narrow it. Search bookmarks and likes separately to match either collection; combining the flags requires both. All-account results deduplicate posts and show a representative matching account. Repeat a search for each account when you need every saving account's provenance.

An X archive can contain likes or bookmark IDs without the post body. Live API access may fill those gaps, subject to X access and history limits. Local DM archive search works independently of live DM fetching; the inherited live DM transport currently requires a private `bird` installation. Search is SQLite full-text search.

## Ongoing sync

The existing `jobs sync-account` and `jobs install-account-launchd` commands can refresh bookmarks and likes for each account. Use a separate label per account, an explicit program path, `--mode xurl`, and `--steps bookmarks,likes`. Verify a manual run and agree on API use and cadence before loading a schedule. See [jobs](docs/jobs.md) for available limits and audit files.

Keep Git backup auto-sync disabled until a private archive destination is explicitly configured. Sharing this source repository does not share the local archive. Additional fleet machines install code and the skill; they need their own authorized account/data setup to search locally.

An automatic selected-author watchlist is still pending. Cached X Lists filter stored posts and do not automatically archive each member's timeline. Electron and gateway product integration is also deferred.

## Development

Use the workspace Flywheel guidance and [Neo Archive skill](.agents/skills/neo-archive/SKILL.md). Relevant checks:

```sh
./scripts/bun-canary.sh run --bun check
./scripts/bun-canary.sh run --bun test --maxWorkers=4
```

Inherited documentation under `docs/` describes the existing command capabilities. Historical release notes and the MIT license retain upstream attribution. The inherited Pages and Homebrew publication jobs are restricted to the upstream repository; configure Neotask publication separately if needed.
