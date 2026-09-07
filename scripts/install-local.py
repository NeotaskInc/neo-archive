#!/usr/bin/env python3
"""Install this checkout's CLI and developer skill without changing global runtimes."""
import os
from pathlib import Path
import shlex
import subprocess


def main():
    root = Path(__file__).resolve().parent.parent
    entry = root / 'bin' / 'neo-archive.mjs'
    if not (root / 'dist' / 'cli' / 'neo-archive.js').is_file():
        raise SystemExit('Build Neo Archive before installing: ./scripts/bun-canary.sh run --bun build')
    core = root / 'dist' / 'native' / 'neoarchive-core'
    if not core.is_file() or not os.access(core, os.X_OK):
        raise SystemExit('Build the native core before installing: node scripts/build-native.mjs')
    subprocess.run([str(core), '--version'], check=True, capture_output=True, text=True)
    runtime = subprocess.check_output([str(root / 'scripts' / 'install-bun-canary.sh')], text=True, timeout=300).strip()
    home = Path.home()
    commands = [home / '.local' / 'bin' / name for name in ('neoarchive', 'neo-archive')]
    marker = '# Neo Archive local installer: ' + str(root)
    wrapper = '#!/bin/sh\n' + marker + '\nexec ' + shlex.quote(runtime) + ' --no-env-file ' + shlex.quote(str(entry)) + ' "$@"\n'
    skill = root / '.agents' / 'skills' / 'neo-archive'
    links = [home / folder / 'skills' / 'neo-archive' for folder in ('.codex', '.claude', '.agents')]
    # Check every destination before changing any installation.
    for command in commands:
        if command.is_symlink() or (command.exists() and marker not in command.read_text().splitlines()):
            raise SystemExit(f'Refusing to overwrite another command: {command}')
    for link in links:
        if os.path.lexists(link) and not (link.is_symlink() and link.resolve() == skill):
            raise SystemExit(f'Refusing to overwrite another skill: {link}')
    for command in commands:
        command.parent.mkdir(parents=True, exist_ok=True)
        command.write_text(wrapper)
        command.chmod(0o755)
    for link in links:
        link.parent.mkdir(parents=True, exist_ok=True)
        if not link.is_symlink():
            link.symlink_to(skill, target_is_directory=True)
    print(f'Installed {commands[0]} (compatibility alias: {commands[1].name})')
    print(f'Developer skill: {skill}')
    print('Run neoarchive --json init, then import and authenticate each real account.')


if __name__ == '__main__':
    main()
