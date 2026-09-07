---
title: Compose & Reply
description: "Post tweets, reply to tweets, and reply to DMs from the CLI or web app."
---

# Compose & Reply

Three verbs cover everything you can publish: `post`, `reply`, and `dm`.

```bash
neoarchive compose post "Ship local software."
neoarchive compose reply tweet_004 "On it."
neoarchive compose dm dm_003 "Send it over."
```

All three use the active live transport (`auto` by default — `xurl` first, `bird` second). They never touch SQLite when the live call fails, so a failed publish does not leave a half-state row behind.

## compose post

Post a new tweet on the active account.

```bash
neoarchive compose post "Ship local software."
neoarchive compose post --account acct_primary "Multi-account post."
```

Flags:

- `--account <username>` — account username or stored ID
- `--reply-to <tweet-id>` — equivalent to `compose reply`
- `--quote <tweet-id>` — quote-tweet
- `--media <path>` — attach a local file (planned)
- `--dry-run` — render the payload, do not publish

## compose reply

Reply to an existing tweet by ID.

```bash
neoarchive compose reply 1891234567890 "On it."
neoarchive compose reply tweet_004 "Already shipped."
```

The `<tweet-id>` argument accepts:

- canonical numeric Twitter IDs (e.g. `1891234567890`)
- local short IDs from search results (e.g. `tweet_004`)
- canonical Twitter URLs (e.g. `https://x.com/user/status/1891...`)

## compose dm

Reply within an existing DM conversation by conversation ID.

```bash
neoarchive compose dm dm_003 "Send it over."
neoarchive compose dm dm_004 --account acct_primary "Sounds good."
```

`compose dm` resolves the conversation, picks the right transport (`bird` is preferred for DM writes because OAuth2 DM scopes are flaky), and merges the sent message back into the local DM tables.

All compose commands accept `--account`. For DMs, the selected account must own the local conversation. Set `accounts.default` in `config.json` for a recurring choice.

## Disabling live writes

Set `NEO_ARCHIVE_DISABLE_LIVE_WRITES=1` to make every compose verb a dry-run regardless of flags. CI and the test suite rely on this — see [Configuration](configuration.md#disabling-live-writes).

```bash
export NEO_ARCHIVE_DISABLE_LIVE_WRITES=1
neoarchive compose post "this will not actually post"
```

The command still validates the payload and prints what *would* have been sent.

## Web UI

The web app's `Home`, `Mentions`, and `DMs` lanes all share the same compose backend. Drafts are stored locally in SQLite while you type, so closing a tab does not lose work.

## Exit codes

- `0` — published
- `2` — invalid usage (missing tweet ID, empty body)
- `3` — auth unavailable for the active account
- `4` — transport unavailable (`xurl` and `bird` both failed)

## See also

- [Configuration](configuration.md) — transport precedence and `NEO_ARCHIVE_DISABLE_LIVE_WRITES`
- [Mentions](mentions.md) — pull a unreplied queue, then reply
- [DMs](dms.md) — DM triage flow
