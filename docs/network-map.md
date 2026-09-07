---
title: Network Map
description: "Map current followers/following by profile location."
---

# Network Map

The web app has a **Map** view at `/network-map`. It reads current `follow_edges` plus hydrated `profiles.location`, normalizes free-form locations, geocodes them into the local SQLite cache, and plots followers, following, and mutuals.

Runtime keys:

```bash
OPENCAGE_API_KEY=...
NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN=...
```

`NEO_ARCHIVE_MAPBOX_ACCESS_TOKEN` is also accepted for local-only Neo Archive runs. The Mapbox token is sent to the browser; use a public Mapbox token. If Mapbox is missing, Neo Archive renders a lightweight local scatter map. If OpenCage is missing, Neo Archive uses cached geocodes and explicit coordinate locations only.

Useful refresh flow:

```bash
neoarchive sync followers --yes --json
neoarchive sync following --yes --json
neoarchive import hydrate-profiles --json
./scripts/bun-canary.sh run --bun dev
```
