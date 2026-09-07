# Follow Graph

Neo Archive keeps followers/following in local SQLite and makes graph queries cache-only by default. Agents should use the `graph` commands for analysis and the `sync followers` / `sync following` commands only when a human intentionally refreshes data.

## Safety Contract

- `neoarchive graph *` commands never call X.
- `neoarchive sync followers` and `neoarchive sync following` default to dry-run.
- Live sync requires `--yes`.
- `--mode auto` prefers `bird` and falls back to `xurl`; use `--mode xurl` only when the OAuth2 follow endpoints work for the account.
- Fresh sync cache is reused unless `--refresh` is passed.
- The default follow-graph cache TTL is 24 hours.
- Capped syncs are recorded as incomplete snapshots and are not used for churn events.
- Complete snapshots are diffed into append-only `started` and `ended` events.

## Setup

```bash
neoarchive init
neoarchive auth status --json
```

The default account comes from the local Neo Archive account table. Pass `--account <accountId>` when working with a non-default account.

## Preflight Before Spending X Reads

Always run dry-run first:

```bash
neoarchive sync followers --json
neoarchive sync following --json
```

Dry-run output reports the cache key, whether a fresh cache exists, the page size, caps, and whether a live request would be needed.

## Refresh Followers And Following

Full refresh:

```bash
neoarchive sync followers --yes --json
neoarchive sync following --yes --json
```

Force a transport only when debugging:

```bash
neoarchive sync followers --mode bird --yes --json
neoarchive sync followers --mode xurl --yes --json
```

Capped refresh for cheaper inspection:

```bash
neoarchive sync followers --yes --max-pages 1 --allow-partial --json
neoarchive sync following --yes --max-pages 1 --allow-partial --json
```

Capped syncs are recorded as incomplete snapshots for audit, but they are not used to create churn events or update current edges. `--allow-partial` acknowledges that expected warning; it is not a persistence gate.

Repeat runs with the same account, page size, and caps reuse fresh cache:

```bash
neoarchive sync followers --yes --json
```

Force a new live fetch only when needed:

```bash
neoarchive sync followers --yes --refresh --json
```

## Agent Query Commands

After at least one complete follower and following snapshot, agents can query locally:

```bash
neoarchive graph summary --json
neoarchive graph events --since 2026-05-01 --json
neoarchive graph top-followers --limit 20 --json
neoarchive graph non-mutual-following --sort followers --limit 100 --json
neoarchive graph mutuals --json
neoarchive graph unfollowed --date 2026-05-01 --json
```

Recommended agent order:

1. Run `neoarchive graph summary --json`.
2. If counts are zero or snapshots are stale, ask for a human-approved `sync followers --yes` and `sync following --yes`.
3. Run only `graph` commands for analysis.
4. Do not pass `--refresh` unless the user explicitly asks to spend live reads.

## Stored Data

The follow graph uses:

- `follow_snapshots` for each sync attempt.
- `follow_snapshot_members` for users seen in each snapshot.
- `follow_edges` for current complete follower/following edges.
- `follow_events` for append-only `started` and `ended` edge changes.
- `profiles.public_metrics_json` and `profiles.followers_count` for local sorting.

Incomplete snapshots preserve what was fetched but do not update current edges or churn events. This prevents capped reads from being mistaken for unfollows.
