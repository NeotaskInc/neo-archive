---
title: Install
description: "Install Neo Archive from the Neotask source repository with its pinned local runtime."
---

# Install

Neo Archive installs from `NeotaskInc/neo-archive`. No Neo Archive npm package or Homebrew formula is configured.

```sh
git clone https://github.com/NeotaskInc/neo-archive.git
cd neo-archive
./scripts/bun-canary.sh install --frozen-lockfile
./scripts/bun-canary.sh run --bun build
python3 scripts/install-local.py
neo-archive --version
```

The installer exposes the command in `~/.local/bin` and links the developer skill into Codex, Claude, and shared agent discovery. It refuses to overwrite another installation. Keep the source checkout at its installed path.

The runtime helper downloads the exact Bun canary recorded in `toolchains/bun-canary.conf` and verifies the artifact, binary, and revision. It installs under the ignored project-local `.toolchains/` directory. It leaves global Node and Bun defaults unchanged. Supported bootstrap targets are macOS arm64 and Linux x64; `curl`, `unzip`, and a SHA-256 utility are required.

Node users can use the version range in `package.json` and the `build:node`, `test:node`, and `coverage:node` scripts. Bun owns dependency installation through the checked-in lockfile.

## Local data and authentication

```sh
neo-archive --json init
neo-archive --json db stats
```

Data lives in `~/.neo-archive` unless `NEO_ARCHIVE_HOME` is set. Import each supplied archive with an explicit owner:

```sh
neo-archive import archive /path/to/account-archive.zip --account HANDLE
```

Then follow [Sign in](auth.md) to configure `xurl` and authorize each X account. Local archive search works before live authentication. The CLI's transport status is a coarse probe; verify the selected X identity and an actual bookmark sync before installing recurring jobs.

Workspace fleet setup clones the source and discovers its skill. Build and install the runtime where it is needed. Private archives, credentials, and account schedules remain specific to their authorized machine.
