---
title: Quickstart
description: "Install neo-archive, import your X archive to establish account identity, connect live transports, and start the local web app."
---

# Quickstart

Set up a local SQLite workspace for your tweets, DMs, likes, and bookmarks, then connect live transports and start the web UI. Installation is quick; first-time account setup depends on having an X archive, which X may take a few days to prepare.

## 1. Install

```bash
brew install steipete/tap/neo-archive
neoarchive --version
```

Other install options (npm, source) are on [Install](install.md).

## 2. Initialize local state

```bash
neoarchive init
neoarchive auth status --json
neoarchive db stats --json
```

`init` creates `~/.neo-archive/`, opens an empty SQLite database, and writes a default config when none exists. To explore immediately with no archive, credentials, or network access, use the self-contained demo instead:

```bash
neoarchive init --demo
neoarchive serve
```

The demo includes sample tweets, DMs, profiles, and links. Its output also suggests useful read-only commands to try next.

`auth status` runs Neo Archive's coarse xurl status probe. Verify xurl with `xurl whoami`. Existing private bird users can verify bird with `bird whoami`. If you want live sync, follow [Sign in](auth.md); skip it if you only need archive import.

## 3. Find and import an archive

If you downloaded your Twitter/X archive from <https://x.com/settings/download_your_data>, point neo-archive at it. On macOS, autodiscovery looks in `~/Downloads` and Spotlight first.

```bash
neoarchive archive find --json
neoarchive import archive --json
# or with an explicit path:
neoarchive import archive ~/Downloads/twitter-archive-2025.zip --json
```

Optional profile hydration through xurl fills bios, follower counts, and avatars from live Twitter metadata. It can perform hundreds or thousands of live profile reads on large archives, so run it only when you are ready to spend those X API reads. With an existing private bird installation, the command can instead correct the seeded local account identity from `bird whoami` without bulk-hydrating imported profiles:

```bash
neoarchive import hydrate-profiles --json
```

Later, when you download a newer archive, you can refresh only one stale slice without wiping live-synced or local data:

```bash
neoarchive import archive ~/Downloads/twitter-archive-2026.zip --select likes,bookmarks --json
neoarchive import archive ~/Downloads/twitter-archive-2026.zip --select directMessages --json
```

Valid slices: `tweets`, `likes`, `bookmarks`, `profiles`, `directMessages`, `followers`, `following`. Use `dms` as a short alias for `directMessages`.

No archive yet? Request one and wait for X to prepare it. Do not run live sync against an empty or demo database: `auth status` and `auth use` do not establish real account identity.

## 4. Sync live state

Run this step only after archive import has established your account.

`auto` tries `xurl` first, then falls back to `bird`. Use `bird` directly for surfaces where the API path is rate-limited.

```bash
neoarchive sync likes --mode auto --limit 100 --refresh --json
neoarchive sync bookmarks --mode auto --limit 100 --refresh --json
neoarchive sync timeline --limit 100 --refresh --json
neoarchive sync mention-threads --limit 30 --delay-ms 1500 --json
```

Without `xurl` or `bird`, use the imported archive and local search/read workflows.

## 5. Start the web app

```bash
neoarchive serve
```

Open <http://localhost:3000>. The default lanes:

- **Home** — read and reply without fighting the main Twitter timeline
- **Mentions** — work the reply queue with replied/unreplied filters
- **Likes** / **Bookmarks** — revisit saved posts
- **DMs** — triage by sender follower count, bio, and influence
- **Inbox** — let heuristics or OpenAI float likely-important items
- **Blocks** — maintain a local-first account-scoped blocklist

Use the Sync button in Home, Mentions, Likes, Bookmarks, or DMs when you want fresh live data. Browser reloads only reread local SQLite; explicit sync avoids surprise live reads and rate-limit spend. Home and Mentions can optionally auto-sync per account at 5m, 10m, 15m, 30m, or 1h intervals. The setting stays in this browser, skips hidden-page runs, prevents overlap, and backs off after failures. Use [`neoarchive jobs`](jobs.md) instead when refresh must continue after the page closes.

## 6. Run real CLI workflows

Search every tweet you ever liked or bookmarked:

```bash
neoarchive search tweets "local-first" --json
neoarchive search tweets --liked --hide-low-quality --limit 20 --json
neoarchive search tweets --since 2020-01-01 --until 2021-01-01 --originals-only --limit 500 --json
```

Triage mentions for an agent:

```bash
neoarchive mentions export "agent" --unreplied --limit 10
neoarchive inbox --score --hide-low-signal --limit 8 --json
```

Bulk-block a list of obvious AI/spam accounts:

```bash
neoarchive blocks import ~/triage/blocklist.txt --account acct_primary --json
```

Reply from the CLI:

```bash
neoarchive compose post "Ship local software."
neoarchive compose reply 1891234567890 "On it."
neoarchive compose dm dm_003 "Send it over."
```

## 7. Back up locally

`backup export` writes deterministic JSONL shards that round-trip back into SQLite. Push them to a private Git repo:

```bash
neoarchive backup sync \
  --repo ~/Projects/backup-neo-archive \
  --remote https://github.com/steipete/backup-neo-archive.git \
  --json
```

Set `backup.autoSync` in `~/.neo-archive/config.json` and read paths pull + merge from Git when the last check is stale; data-changing commands push back automatically. Full details in [Backup](backup.md).

## Where to go next

- [Configuration](configuration.md) — `~/.neo-archive/config.json`, env vars, and per-account profiles
- [Sync](sync.md) — full reference for likes, bookmarks, timeline, and resumable mention-thread fetches
- [Moderation](moderation.md) — blocks, mutes, bans, and bulk imports
- [Inbox](inbox.md) — heuristic and OpenAI-ranked triage
- [Backup](backup.md) — Git-friendly text shards
- [CLI reference](cli.md) — every subcommand, every flag
