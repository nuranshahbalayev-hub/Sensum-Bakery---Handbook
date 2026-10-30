#!/usr/bin/env python3
"""Bump the app version in both places it lives, then run the data audit.

    python3 tools/release.py          # 1.79 -> 1.80
    python3 tools/release.py 2.0      # set an explicit version

APP_VERSION in index.html and CACHE in sw.js must always match (tools/audit.py
checks it); installed apps only pick up a new index.html when CACHE changes.
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX, SW = os.path.join(ROOT, 'index.html'), os.path.join(ROOT, 'sw.js')


def main():
    html = open(INDEX, encoding='utf-8').read()
    sw = open(SW, encoding='utf-8').read()
    cur = re.search(r'APP_VERSION="(\d+)\.(\d+)"', html)
    if not cur or f"CACHE = 'sensum-v{cur.group(1)}.{cur.group(2)}'" not in sw:
        sys.exit('APP_VERSION and sw.js CACHE do not match; fix them by hand first')
    if len(sys.argv) > 1:
        if not re.fullmatch(r'\d+\.\d+', sys.argv[1]):
            sys.exit('version must look like 1.80')
        new = sys.argv[1]
    else:
        new = f'{cur.group(1)}.{int(cur.group(2)) + 1}'
    old = f'{cur.group(1)}.{cur.group(2)}'
    html = html.replace(f'APP_VERSION="{old}"', f'APP_VERSION="{new}"', 1)
    sw = sw.replace(f"CACHE = 'sensum-v{old}'", f"CACHE = 'sensum-v{new}'", 1)
    open(INDEX, 'w', encoding='utf-8').write(html)
    open(SW, 'w', encoding='utf-8').write(sw)
    print(f'version {old} -> {new}')
    sys.exit(subprocess.call([sys.executable, '-B', os.path.join(ROOT, 'tools', 'audit.py')]))


if __name__ == '__main__':
    main()
