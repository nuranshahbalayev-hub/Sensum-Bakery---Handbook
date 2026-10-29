#!/usr/bin/env python3
"""Add or replace a photo for the handbook.

    python3 tools/photo.py <key> <source-image>

Converts the source to WebP (longest side capped at MAX_SIDE), writes it to
images/<key>.<hash>.webp, points IMAGES[<key>] in index.html at it and deletes
the previous file for that key. The hash is part of the filename, so a swapped
photo gets a new URL and installed apps cannot keep serving the old picture
from the cache. Requires Pillow (pip install pillow).

Remember the usual release steps afterwards: bump APP_VERSION in index.html and
CACHE in sw.js, then run tools/audit.py.
"""
import hashlib
import io
import os
import re
import sys

from PIL import Image, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG_DIR = os.path.join(ROOT, 'images')
INDEX = os.path.join(ROOT, 'index.html')
MAX_SIDE = 1000
QUALITY = 80


def encode(src):
    """Return WebP bytes for an image file path or bytes."""
    im = Image.open(io.BytesIO(src) if isinstance(src, bytes) else src)
    im = ImageOps.exif_transpose(im)
    if im.mode not in ('RGB', 'RGBA'):
        im = im.convert('RGB')
    im.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
    out = io.BytesIO()
    im.save(out, 'WEBP', quality=QUALITY, method=6)
    return out.getvalue()


def store(key, webp):
    """Write images/<key>.<hash>.webp and return the app-relative path."""
    os.makedirs(IMG_DIR, exist_ok=True)
    h = hashlib.sha1(webp).hexdigest()[:8]
    name = f'{key}.{h}.webp'
    with open(os.path.join(IMG_DIR, name), 'wb') as f:
        f.write(webp)
    return 'images/' + name


def remove_old(key, keep):
    pat = re.compile(re.escape(key) + r'\.[0-9a-f]{8}\.webp$')
    for fn in os.listdir(IMG_DIR):
        if pat.match(fn) and 'images/' + fn != keep:
            os.remove(os.path.join(IMG_DIR, fn))


def point_index_at(key, path):
    with open(INDEX, encoding='utf-8') as f:
        html = f.read()
    m = re.search(r'IMAGES=\{', html)
    if not m:
        sys.exit('IMAGES literal not found in index.html')
    pat = re.compile(r'"' + re.escape(key) + r'":"[^"]*"')
    entry = f'"{key}":"{path}"'
    head = html[m.end():]
    if pat.search(head[:head.index('}')]):
        html = html[:m.end()] + pat.sub(entry, head, count=1)
    else:
        html = html[:m.end()] + entry + ',' + head
    with open(INDEX, 'w', encoding='utf-8') as f:
        f.write(html)


def main():
    if len(sys.argv) != 3 or not re.fullmatch(r'[a-z0-9]+', sys.argv[1]):
        sys.exit(__doc__)
    key, src = sys.argv[1], sys.argv[2]
    webp = encode(src)
    path = store(key, webp)
    remove_old(key, path)
    point_index_at(key, path)
    print(f'{key}: {path} ({len(webp) // 1024} KB)')


if __name__ == '__main__':
    main()
