#!/usr/bin/env python3
"""Data audit for Sensum & Bakery handbook.

Reads the embedded DATA / IMAGES / CHANGELOG literals out of index.html and
checks them for drift. Run before every push that touches index.html:

    python3 tools/audit.py

Exit code 1 if any ERROR is found; WARN lines are informational.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NO_LINK = '§нет§'  # trig sentinel: prep is never auto-linked from ingredients
errors, warns = [], []


def err(msg):
    errors.append(msg)


def warn(msg):
    warns.append(msg)


def extract(src, marker, opener, closer):
    """Return the JSON literal that starts at `marker` + opener."""
    start = src.index(marker) + len(marker)
    assert src[start] == opener, marker
    depth, in_str, esc = 0, False, False
    for i in range(start, len(src)):
        c = src[i]
        if in_str:
            if esc:
                esc = False
            elif c == '\\':
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == opener:
            depth += 1
        elif c == closer:
            depth -= 1
            if depth == 0:
                return json.loads(src[start:i + 1])
    raise ValueError('unterminated literal: ' + marker)


def load():
    with open(os.path.join(ROOT, 'index.html'), encoding='utf-8') as f:
        src = f.read()
    data = extract(src, 'DATA=', '{', '}')
    images = extract(src, 'IMAGES=', '{', '}')
    changelog = extract(src, 'CHANGELOG=', '[', ']')
    version = re.search(r'APP_VERSION="([^"]+)"', src).group(1)
    with open(os.path.join(ROOT, 'sw.js'), encoding='utf-8') as f:
        cache = re.search(r"CACHE\s*=\s*'([^']+)'", f.read()).group(1)
    return data, images, changelog, version, cache


def dup_ids(items, label):
    seen = set()
    for x in items:
        if x['id'] in seen:
            err(f'{label}: duplicate id "{x["id"]}"')
        seen.add(x['id'])


def check_parity(D):
    """RU and AZ lists must line up item by item."""
    for key in ('drinks', 'preps', 'vitrina', 'promos'):
        ru, az = D[key + '_ru'], D[key + '_az']
        dup_ids(ru, key + '_ru')
        dup_ids(az, key + '_az')
        if [x['id'] for x in ru] != [x['id'] for x in az]:
            err(f'{key}: RU/AZ id lists differ (count {len(ru)} vs {len(az)})')
            continue
        for a, b in zip(ru, az):
            for field in ('ing', 'steps', 'usedin', 'parts', 'tags'):
                if field in a or field in b:
                    if len(a.get(field, [])) != len(b.get(field, [])):
                        err(f'{key}/{a["id"]}: "{field}" length differs RU {len(a.get(field, []))} vs AZ {len(b.get(field, []))}')
            for field in ('cat', 'temp', 'kind', 'img'):
                if a.get(field) != b.get(field):
                    err(f'{key}/{a["id"]}: "{field}" differs RU {a.get(field)!r} vs AZ {b.get(field)!r}')
    for key in ('CATS', 'KINDS', 'VCATS', 'ALG'):
        if set(D[key + '_ru']) != set(D[key + '_az']):
            err(f'{key}: RU/AZ keys differ')
    for k, v in D['ui'].items():
        for lang in ('ru', 'az'):
            if not str(v.get(lang, '')).strip():
                err(f'ui.{k}: missing "{lang}" string')


def check_refs(D, images):
    for lang in ('ru', 'az'):
        for kind, cats in (('drinks', 'CATS'), ('vitrina', 'VCATS')):
            for x in D[f'{kind}_{lang}']:
                if x['cat'] not in D[f'{cats}_{lang}']:
                    err(f'{kind}_{lang}/{x["id"]}: unknown category "{x["cat"]}"')
        for p in D[f'preps_{lang}']:
            if p['kind'] not in D[f'KINDS_{lang}']:
                err(f'preps_{lang}/{p["id"]}: unknown kind "{p["kind"]}"')
        for x in D[f'vitrina_{lang}']:
            alg = x.get('alg', {})
            for level in alg:
                if level not in ('has', 'may'):
                    err(f'vitrina_{lang}/{x["id"]}: unknown allergen level "{level}"')
            for a in alg.get('has', []) + alg.get('may', []):
                if a not in D[f'ALG_{lang}']:
                    err(f'vitrina_{lang}/{x["id"]}: unknown allergen "{a}"')

    used_imgs = set()
    for key in ('drinks', 'vitrina'):
        for x in D[key + '_ru']:
            img = x.get('img')
            if not img:
                # vitrina cards fall back to an icon (VIT_ICON / VIT_CAT_ICON)
                (warn if key == 'vitrina' else err)(f'{key}/{x["id"]}: no image')
            elif img not in images:
                err(f'{key}/{x["id"]}: image "{img}" missing from IMAGES')
            else:
                used_imgs.add(img)
    for p in D['preps_ru']:
        if p.get('img'):
            used_imgs.add(p['img'])
    for promo in D['promos_ru']:
        used_imgs.add(promo.get('img'))
    for orphan in sorted(set(images) - used_imgs):
        warn(f'IMAGES: "{orphan}" is not referenced by any item')

    item_ids = {x['id'] for k in ('drinks', 'preps', 'vitrina') for x in D[k + '_ru']}
    for promo in D['promos_ru']:
        for part in promo['parts']:
            for i in part['ids'] + part.get('extra', []):
                # ids are lowercase slugs; anything else is a plain display name (e.g. gift-drink choices)
                if isinstance(i, str) and re.fullmatch(r'[a-z0-9]+', i) and i not in item_ids:
                    warn(f'promos/{promo["id"]}: "{i}" is not a drink/prep/vitrina id')


def check_triggers(D):
    """trig must appear in every usedin ingredient (and normally within the prep name)."""
    for lang in ('ru', 'az'):
        drinks = {x['id']: x for x in D[f'drinks_{lang}']}
        preps = {x['id']: x for x in D[f'preps_{lang}']}
        for p in preps.values():
            if p['trig'] == NO_LINK:
                continue
            if p['trig'] not in p['name'].lower():
                warn(f'preps_{lang}/{p["id"]}: trig "{p["trig"]}" is not part of name "{p["name"]}"')
            for u in p['usedin']:
                target = drinks.get(u[2]) or preps.get(u[2])
                if target is None:
                    err(f'preps_{lang}/{p["id"]}: usedin points to unknown id "{u[2]}"')
                    continue
                if not any(p['trig'] in ing[0].lower() for ing in target['ing']):
                    err(f'preps_{lang}/{p["id"]}: "{target["name"]}" ({u[2]}) has no ingredient containing trig "{p["trig"]}"')
            listed = {u[2] for u in p['usedin']}
            for other in list(drinks.values()) + list(preps.values()):
                if other['id'] in listed or other['id'] == p['id']:
                    continue
                if any(p['trig'] in ing[0].lower() for ing in other['ing']):
                    warn(f'preps_{lang}/{p["id"]}: "{other["name"]}" links to it via ingredient but is not in usedin')


def check_meta(D, changelog, version, cache):
    if cache != 'sensum-v' + version:
        err(f'version mismatch: APP_VERSION={version} but sw.js CACHE={cache}')
    ids = {x['id'] for k in ('drinks', 'preps', 'vitrina') for x in D[k + '_ru']}
    for c in changelog:
        for i in c.get('changed', []):
            if i not in ids:
                warn(f'CHANGELOG {c["id"]}: changed id "{i}" does not exist')
        for lang in ('ru', 'az'):
            if not c['title'].get(lang):
                err(f'CHANGELOG {c["id"]}: missing {lang} title')


def main():
    D, images, changelog, version, cache = load()
    check_parity(D)
    check_refs(D, images)
    check_triggers(D)
    check_meta(D, changelog, version, cache)

    print(f'v{version}: {len(D["drinks_ru"])} drinks, {len(D["preps_ru"])} preps, '
          f'{len(D["vitrina_ru"])} vitrina, {len(D["promos_ru"])} promos, {len(images)} images')
    for w in warns:
        print('WARN ', w)
    for e in errors:
        print('ERROR', e)
    print(f'{len(errors)} error(s), {len(warns)} warning(s)')
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
