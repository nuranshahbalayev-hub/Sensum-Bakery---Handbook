#!/usr/bin/env python3
"""Import the written lessons of «Материалы» into index.html.

The lessons live in tools/lessons.json (RU and AZ side by side, one file, edited by hand or by
Claude from the owner's course files). Run

    python3 tools/lessons.py

to check them and rewrite the lesson keys of the DATA literal in index.html:
lessons_ru / lessons_az (the lessons) and lcats_ru / lcats_az (the categories). Nothing else in DATA
changes. Run tools/release.py afterwards.

tools/lessons.json:
    {"cats": {"CF": {"icon": "☕", "ru": {"t": title, "d": one line}, "az": {...}}, ...},
     "lessons": [{"id": "cf-origin", "cat": "CF", "topic": "CF-1",
                  "ru": {"title": ..., "blocks": [...]}, "az": {"title": ..., "blocks": [...]}}, ...]}

`topic` is a code of the theory question bank (ttopics_*): the lesson's «Проверить себя» button starts a
theory test on that topic, so its letters before the dash must be the lesson's category.

A block is exactly one of
    {"h": "heading"}  {"p": "paragraph"}  {"note": "highlighted remark"}
    {"ul": [item, ...]}  {"ol": [item, ...]}      item = "text" or {"b": "bold lead", "t": "the rest"}
    {"table": {"head": [cells], "rows": [[cells], ...]}}
The RU and AZ blocks must have the same shape (same kinds, same list lengths, same table size, same
numbers); the AZ text is a draft until a native speaker has checked it.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(ROOT, 'index.html')
SRC = os.path.join(ROOT, 'tools', 'lessons.json')
KINDS = ('h', 'p', 'note', 'ul', 'ol', 'table')
errors = []


def err(msg):
    errors.append(msg)


def find_data(src):
    start = src.index('DATA={') + 5
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
        elif c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return start, i + 1
    raise ValueError('unterminated DATA literal')


def dump(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':'))


def strings(block):
    """Every text of a block, in reading order."""
    k = kind(block)
    v = block[k]
    if k in ('h', 'p', 'note'):
        return [v]
    if k in ('ul', 'ol'):
        return [s for it in v for s in ([it] if isinstance(it, str) else [it.get('b', ''), it.get('t', '')])]
    return list(v['head']) + [c for r in v['rows'] for c in r]


def kind(block):
    ks = [k for k in KINDS if k in block]
    return ks[0] if len(ks) == 1 and len(block) == 1 else None


def check_block(lid, lang, i, b):
    where = f'{lid} {lang} block {i + 1}'
    k = kind(b)
    if not k:
        err(f'{where}: a block is exactly one of {", ".join(KINDS)}')
        return
    v = b[k]
    if k in ('h', 'p', 'note'):
        if not isinstance(v, str) or not v.strip():
            err(f'{where}: empty {k}')
    elif k in ('ul', 'ol'):
        if not isinstance(v, list) or not v:
            err(f'{where}: empty list')
            return
        for it in v:
            if isinstance(it, str):
                ok = bool(it.strip())
            else:
                ok = isinstance(it, dict) and set(it) == {'b', 't'} and all(isinstance(x, str) and x.strip() for x in it.values())
            if not ok:
                err(f'{where}: bad list item {it!r}')
    else:
        if not (isinstance(v, dict) and set(v) == {'head', 'rows'} and v['head'] and v['rows']):
            err(f'{where}: a table needs head and rows')
            return
        w = len(v['head'])
        for r in v['rows']:
            if len(r) != w:
                err(f'{where}: a table row has {len(r)} cells, the head has {w}')


def shape(b):
    k = kind(b)
    v = b[k]
    if k in ('h', 'p', 'note'):
        return (k,)
    if k in ('ul', 'ol'):
        return (k, tuple('s' if isinstance(it, str) else 'b' for it in v))
    return (k, len(v['head']), len(v['rows']))


def digits(texts):
    return sorted(re.findall(r'\d+(?:[.,]\d+)?', ' '.join(texts)))


def main():
    with open(SRC, encoding='utf-8') as f:
        doc = json.load(f)
    with open(INDEX, encoding='utf-8') as f:
        src = f.read()
    a, b = find_data(src)
    raw = src[a:b]
    data = json.loads(raw)
    if dump(data) != raw:
        print('DATA does not round-trip through JSON unchanged; refusing to rewrite it.')
        return 1
    topics = data.get('ttopics_ru', {})

    cats = doc['cats']
    for c, v in cats.items():
        if not (isinstance(v.get('icon'), str) and v['icon']):
            err(f'category {c}: no icon')
        for lang in ('ru', 'az'):
            t = v.get(lang, {})
            if not (t.get('t') and t.get('d')):
                err(f'category {c}: needs a title (t) and a line (d) in {lang.upper()}')

    seen = set()
    for les in doc['lessons']:
        lid = les.get('id', '?')
        if not re.fullmatch(r'[a-z0-9-]+', lid):
            err(f'{lid}: the id is lowercase letters, digits and dashes')
        if lid in seen:
            err(f'{lid}: duplicate id')
        seen.add(lid)
        if les['cat'] not in cats:
            err(f'{lid}: unknown category "{les["cat"]}"')
        if les['topic'] not in topics:
            err(f'{lid}: topic "{les["topic"]}" is not in the question bank')
        elif les['topic'].split('-')[0] != les['cat']:
            err(f'{lid}: topic "{les["topic"]}" is not of category {les["cat"]}')
        ru, az = les['ru'], les['az']
        for lang, l in (('RU', ru), ('AZ', az)):
            if not l.get('title', '').strip():
                err(f'{lid}: empty {lang} title')
            if not l.get('blocks'):
                err(f'{lid}: no {lang} blocks')
            for i, bl in enumerate(l.get('blocks', [])):
                check_block(lid, lang, i, bl)
                if kind(bl) and any(re.search(r'</?script|<!--|<[a-z]', s, re.I) for s in strings(bl)):
                    err(f'{lid} {lang} block {i + 1}: markup in text')
        if len(ru['blocks']) != len(az['blocks']):
            err(f'{lid}: {len(ru["blocks"])} RU blocks but {len(az["blocks"])} AZ blocks')
            continue
        for i, (x, y) in enumerate(zip(ru['blocks'], az['blocks'])):
            if kind(x) and kind(y):
                if shape(x) != shape(y):
                    err(f'{lid} block {i + 1}: RU and AZ differ in shape {shape(x)} / {shape(y)}')
                elif digits(strings(x)) != digits(strings(y)):
                    err(f'{lid} block {i + 1}: RU and AZ differ in numbers {digits(strings(x))} / {digits(strings(y))}')
        for bl in az['blocks'] + [{'h': az['title']}]:
            if kind(bl) and any(re.search('[а-яёА-ЯЁ]', s) for s in strings(bl)):
                err(f'{lid}: Russian letters in the AZ text')
                break
    if errors:
        print('\n'.join('ERROR ' + e for e in errors))
        return 1
    if not doc['lessons']:
        print('No lessons.')
        return 1

    used = [c for c in cats if any(l['cat'] == c for l in doc['lessons'])]
    new = {}
    for lang in ('ru', 'az'):
        new['lessons_' + lang] = [{'id': l['id'], 'cat': l['cat'], 'topic': l['topic'], 'title': l[lang]['title'],
                                   'blocks': l[lang]['blocks']} for l in doc['lessons']]
        new['lcats_' + lang] = {c: {'ic': cats[c]['icon'], 't': cats[c][lang]['t'], 'd': cats[c][lang]['d']} for c in used}
    for k in list(data):
        if k.startswith(('lessons_', 'lcats_')):
            del data[k]
    data.update(new)
    out = src[:a] + dump(data) + src[b:]
    with open(INDEX, 'w', encoding='utf-8') as f:
        f.write(out)
    per = {c: sum(1 for l in doc['lessons'] if l['cat'] == c) for c in used}
    print(f'{len(doc["lessons"])} lessons {per}; index.html {len(src) // 1024} -> {len(out) // 1024} KB')
    return 0


if __name__ == '__main__':
    sys.exit(main())
