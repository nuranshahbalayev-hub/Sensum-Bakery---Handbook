#!/usr/bin/env python3
"""Data audit for Sensum & Bakery handbook.

Reads the embedded DATA / IMAGES / CHANGELOG literals out of index.html and
checks them for drift. Run before every push that touches index.html:

    python3 tools/audit.py

Exit code 1 if any ERROR is found; WARN lines are informational.
"""
import hashlib
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
    data['ALG_ORDER'] = extract(src, 'ALG_ORDER=', '[', ']')  # the order allergens are listed in on a card
    data['SPOTLIGHT'] = extract(src, 'SPOTLIGHT=', '[', ']')  # new-drink banner above «Напитки»
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
            for field in ('ing', 'steps', 'usedin', 'parts', 'tags', 'anote'):
                if field in a or field in b:
                    if len(a.get(field, [])) != len(b.get(field, [])):
                        err(f'{key}/{a["id"]}: "{field}" length differs RU {len(a.get(field, []))} vs AZ {len(b.get(field, []))}')
            # 'alg' and the vitrina facts (weight, storage, shelf life, nutrition) are language-neutral
            for field in ('cat', 'temp', 'kind', 'img', 'alg', 'wt', 'stor', 'life', 'kcal', 'nut'):
                if a.get(field) != b.get(field):
                    err(f'{key}/{a["id"]}: "{field}" differs RU {a.get(field)!r} vs AZ {b.get(field)!r}')
    for key in ('CATS', 'KINDS', 'VCATS', 'ALG'):
        if set(D[key + '_ru']) != set(D[key + '_az']):
            err(f'{key}: RU/AZ keys differ')
    for k, v in D['ui'].items():
        for lang in ('ru', 'az'):
            if not str(v.get(lang, '')).strip():
                err(f'ui.{k}: missing "{lang}" string')


def check_facts(x):
    """Vitrina facts: wt grams, stor [min, max] °C, life [n, 'h'|'d'], kcal and nut [protein, fat, carbs] per 100 g."""
    n = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0
    bad = []
    if 'wt' in x and not (isinstance(x['wt'], int) and x['wt'] > 0): bad.append('wt')
    if 'stor' in x and not (isinstance(x['stor'], list) and len(x['stor']) == 2
                            and all(isinstance(t, int) for t in x['stor']) and x['stor'][0] < x['stor'][1]): bad.append('stor')
    if 'life' in x and not (isinstance(x['life'], list) and len(x['life']) == 2
                            and isinstance(x['life'][0], int) and x['life'][0] > 0 and x['life'][1] in ('h', 'd')): bad.append('life')
    if 'kcal' in x and not n(x['kcal']): bad.append('kcal')
    if 'nut' in x and not (isinstance(x['nut'], list) and len(x['nut']) == 3 and all(map(n, x['nut']))): bad.append('nut')
    for f in bad:
        err(f'vitrina/{x["id"]}: malformed "{f}": {x[f]!r}')


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
            if lang == 'ru':
                check_facts(x)
        for a in D[f'ALG_{lang}']:
            if a not in D['ALG_ORDER']:
                err(f'ALG_{lang}: "{a}" is missing from ALG_ORDER in the app code')

    # IMAGES maps key -> images/<key>.<sha1[:8]>.webp (see tools/photo.py)
    img_dir = os.path.join(ROOT, 'images')
    for key, path in images.items():
        m = re.fullmatch(r'images/([a-z0-9]+)\.([0-9a-f]{8})\.webp', path)
        if not m or m.group(1) != key:
            err(f'IMAGES["{key}"]: unexpected path "{path}"')
            continue
        full = os.path.join(ROOT, path)
        if not os.path.isfile(full):
            err(f'IMAGES["{key}"]: file {path} does not exist')
        else:
            with open(full, 'rb') as f:
                if hashlib.sha1(f.read()).hexdigest()[:8] != m.group(2):
                    err(f'IMAGES["{key}"]: hash in {path} does not match file content')
    on_disk = set(os.listdir(img_dir)) if os.path.isdir(img_dir) else set()
    for fn in sorted(on_disk - {os.path.basename(p) for p in images.values()}):
        warn(f'images/{fn} is not referenced by IMAGES (leftover file)')

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


THEORY_TYPES = {'one', 'multi', 'order', 'num'}
THEORY_LEVELS = {'trainee', 'barista', 'senior'}


def check_theory(D):
    """The question bank: RU and AZ line up, the answer key points at real options, every topic is named."""
    ru, az = D.get('theory_ru', []), D.get('theory_az', [])
    dup_ids(ru, 'theory_ru')
    dup_ids(az, 'theory_az')
    for key in ('tdirs', 'ttopics'):
        if list(D.get(key + '_ru', {})) != list(D.get(key + '_az', {})):
            err(f'{key}: RU/AZ keys differ')
    if [x['id'] for x in ru] != [x['id'] for x in az]:
        err(f'theory: RU/AZ id lists differ (count {len(ru)} vs {len(az)})')
        return
    used = set()
    for a, b in zip(ru, az):
        qid, t = a['id'], a.get('type')
        for f in ('topic', 'lvl', 'type', 'ans'):
            if a.get(f) != b.get(f):
                err(f'theory/{qid}: "{f}" differs RU {a.get(f)!r} vs AZ {b.get(f)!r}')
        if t not in THEORY_TYPES:
            err(f'theory/{qid}: unknown type "{t}"')
            continue
        if a.get('lvl') not in THEORY_LEVELS:
            err(f'theory/{qid}: unknown level "{a.get("lvl")}"')
        used.add(a['topic'])
        if a['topic'] not in D['ttopics_ru']:
            err(f'theory/{qid}: topic "{a["topic"]}" has no name in ttopics')
        elif a['topic'].split('-')[0] not in D['tdirs_ru']:
            err(f'theory/{qid}: topic "{a["topic"]}" has no direction in tdirs')
        for lang, x in (('RU', a), ('AZ', b)):
            if not x.get('q', '').strip():
                err(f'theory/{qid}: empty {lang} question')
        # an AZ text copied from the Russian exam keeps its Cyrillic letters
        if any(re.search('[А-Яа-яЁё]', s) for s in [b.get('q', '')] + b.get('opts', [])):
            err(f'theory/{qid}: AZ text contains Russian letters')
        ans = a.get('ans')
        if t == 'num':
            if 'opts' in a or 'opts' in b:
                err(f'theory/{qid}: a numeric question has no options')
            if isinstance(ans, bool) or not isinstance(ans, (int, float)):
                err(f'theory/{qid}: the answer must be a number, got {ans!r}')
            continue
        for lang, x in (('RU', a), ('AZ', b)):
            o = x.get('opts', [])
            if len(o) != 4 or not all(s.strip() for s in o) or len(set(o)) != 4:
                err(f'theory/{qid}: {lang} needs four different, non-empty options')
        ints = lambda v: isinstance(v, list) and all(isinstance(i, int) and not isinstance(i, bool) and 0 <= i < 4 for i in v)
        if t == 'one' and not (isinstance(ans, int) and not isinstance(ans, bool) and 0 <= ans < 4):
            err(f'theory/{qid}: "one" needs the index of the right option, got {ans!r}')
        if t == 'multi' and not (ints(ans) and len(ans) >= 2 and ans == sorted(set(ans))):
            err(f'theory/{qid}: "multi" needs two or more sorted, distinct indexes, got {ans!r}')
        if t == 'order' and not (ints(ans) and sorted(ans) == [0, 1, 2, 3]):
            err(f'theory/{qid}: "order" needs every index once, got {ans!r}')
    for k in D.get('ttopics_ru', {}):
        if k not in used:
            warn(f'ttopics: topic "{k}" has no questions')


LESSON_KINDS = ('h', 'p', 'note', 'ul', 'ol', 'table')


def lesson_texts(b):
    k = next((x for x in LESSON_KINDS if x in b), None)
    v = b.get(k)
    if k in ('h', 'p', 'note'):
        return [v]
    if k in ('ul', 'ol'):
        return [s for it in v for s in ([it] if isinstance(it, str) else [it.get('b', ''), it.get('t', '')])]
    if k == 'table':
        return list(v['head']) + [c for r in v['rows'] for c in r]
    return []


def lesson_shape(b):
    ks = [x for x in LESSON_KINDS if x in b]
    if len(ks) != 1 or len(b) != 1:
        return None
    k, v = ks[0], b[ks[0]]
    if k in ('h', 'p', 'note'):
        return (k,)
    if k in ('ul', 'ol'):
        return (k, tuple('s' if isinstance(i, str) else 'b' for i in v))
    return (k, len(v['head']), tuple(len(r) for r in v['rows']))


def check_lessons(D):
    """The written lessons of «Материалы»: RU and AZ line up block by block, topic and category exist."""
    ru, az = D.get('lessons_ru', []), D.get('lessons_az', [])
    dup_ids(ru, 'lessons_ru')
    dup_ids(az, 'lessons_az')
    if list(D.get('lcats_ru', {})) != list(D.get('lcats_az', {})):
        err('lcats: RU/AZ keys differ')
    if [x['id'] for x in ru] != [x['id'] for x in az]:
        err(f'lessons: RU/AZ id lists differ (count {len(ru)} vs {len(az)})')
        return
    for a, b in zip(ru, az):
        lid = a['id']
        for f in ('cat', 'topic'):
            if a.get(f) != b.get(f):
                err(f'lessons/{lid}: "{f}" differs RU {a.get(f)!r} vs AZ {b.get(f)!r}')
        if a['cat'] not in D.get('lcats_ru', {}):
            err(f'lessons/{lid}: category "{a["cat"]}" is not in lcats')
        if a['topic'] not in D.get('ttopics_ru', {}):
            err(f'lessons/{lid}: topic "{a["topic"]}" is not in ttopics (the «Проверить себя» test needs it)')
        elif a['topic'].split('-')[0] != a['cat']:
            err(f'lessons/{lid}: topic "{a["topic"]}" is not of category {a["cat"]}')
        elif not any(q['topic'] == a['topic'] for q in D.get('theory_ru', [])):
            warn(f'lessons/{lid}: topic "{a["topic"]}" has no questions yet')
        if len(a['blocks']) != len(b['blocks']):
            err(f'lessons/{lid}: {len(a["blocks"])} RU blocks vs {len(b["blocks"])} AZ blocks')
            continue
        for i, (x, y) in enumerate(zip(a['blocks'], b['blocks'])):
            sx, sy = lesson_shape(x), lesson_shape(y)
            if sx is None or sy is None:
                err(f'lessons/{lid} block {i + 1}: a block is exactly one of {", ".join(LESSON_KINDS)}')
            elif sx != sy:
                err(f'lessons/{lid} block {i + 1}: RU and AZ differ in shape')
            elif sorted(re.findall(r'\d+(?:[.,]\d+)?', ' '.join(lesson_texts(x)))) != sorted(re.findall(r'\d+(?:[.,]\d+)?', ' '.join(lesson_texts(y)))):
                err(f'lessons/{lid} block {i + 1}: RU and AZ differ in numbers')
            if sx and sx[0] != 'table' and any(not t.strip() for t in lesson_texts(x) + lesson_texts(y)):
                err(f'lessons/{lid} block {i + 1}: empty text')
        texts = [b['title']] + [s for bl in b['blocks'] for s in lesson_texts(bl)]
        if any(re.search('[А-Яа-яЁё]', s) for s in texts):
            err(f'lessons/{lid}: AZ text contains Russian letters')


def check_meta(D, changelog, version, cache):
    if cache != 'sensum-v' + version:
        err(f'version mismatch: APP_VERSION={version} but sw.js CACHE={cache}')
    drink_ids = {x['id'] for x in D['drinks_ru']}
    for s in D['SPOTLIGHT']:
        if s.get('id') not in drink_ids:
            err(f'SPOTLIGHT: "{s.get("id")}" is not a drink id')
        dates = [s.get('start', ''), s.get('end', '')]
        if not all(re.fullmatch(r'\d{4}-\d{2}-\d{2}', x) for x in dates) or dates[0] > dates[1]:
            err(f'SPOTLIGHT {s.get("id")}: start/end must be YYYY-MM-DD with start <= end, got {dates}')
    ids = {x['id'] for k in ('drinks', 'preps', 'vitrina') for x in D[k + '_ru']}
    for c in changelog:
        for i in c.get('changed', []):
            if i not in ids:
                warn(f'CHANGELOG {c["id"]}: changed id "{i}" does not exist')
        for lang in ('ru', 'az'):
            if not c['title'].get(lang):
                err(f'CHANGELOG {c["id"]}: missing {lang} title')


def check_lesson_totals(D):
    """The script pays an owl for all the lessons of a category, so its LESSON_TOTALS must be the real number of lessons per id prefix."""
    gs = os.path.join(ROOT, 'tools', 'apps-script', 'Code.gs')
    if not os.path.exists(gs):
        return
    m = re.search(r'const LESSON_TOTALS = \{([^}]*)\}', open(gs, encoding='utf-8').read())
    if not m:
        err('Code.gs: LESSON_TOTALS not found')
        return
    totals = {k: int(v) for k, v in re.findall(r'(\w+)\s*:\s*(\d+)', m.group(1))}
    real = {}
    for x in D.get('lessons_ru', []):
        p = x['id'].split('-')[0]
        real[p] = real.get(p, 0) + 1
    if totals != real:
        err(f'Code.gs LESSON_TOTALS {totals} differs from the lessons in index.html {real}')


COLOR_RX = re.compile(r'#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(')
RUNTIME_VARS = {'--stick', '--tabbar-h', '--ts'}  # set from JS (setStick(), the text size)
# the only rules whose font-size may stay in px (it does not follow «Размер текста»): glyphs in a fixed box
# (icon squares, round buttons, answer circles, emoji on placeholders and badges) and the chrome iOS keeps
# fixed too (the brand, the tab bar, the header buttons, the «A» samples of the text-size stepper);
# readable text uses var(--fs-*) or calc(N * var(--ts))
FIXED_FS = {
    '.brand .bname', 'nav.tabs button', 'nav.tabs button .sym', '.langbtn', '.themebtn', '.tsize .a1', '.tsize .a2',
    '.search>.sym', '.search .clr i', '.fav', '.close', '.pclose', '.ico', '.tile .ti', '.mode>.mi', '.opt .mk', '.opt .mk .sym',
    '.ws', '.lvl', '.glv', '.bigmark', '.bdg span', '.bdgs .bico', '.bdgs summary::after',
    '.card .ph.noimg span', '.card .ph.noimg .emo', '.hero.noimg span', '.hero.noimg .emo', '.fph.noimg span',
}
DURATION_RX = re.compile(r'(?<![\w.-])\d*\.?\d+m?s\b')


def css_rules(css):
    """(selector, body) for every rule, @media blocks unwrapped; comments removed."""
    css = re.sub(r'/\*.*?\*/', '', css, flags=re.S)
    out, i, n = [], 0, len(css)
    while i < n:
        j = css.find('{', i)
        if j < 0:
            break
        pre, d, k = css[i:j].strip(), 0, j
        while True:
            if css[k] == '{':
                d += 1
            elif css[k] == '}':
                d -= 1
                if d == 0:
                    break
            k += 1
        body = css[j + 1:k]
        if pre.startswith('@media'):
            out += css_rules(body)
        elif not pre.startswith('@'):
            out.append((pre, body))
        i = k + 1
    return out


def check_css(src):
    """design system rules: colours live only in the tokens of :root (light) and :root[data-theme="dark"];
    every var() used is defined; no inline style carries a colour; readable text follows the text size
    (no px font-size outside FIXED_FS); durations come from tokens (--dur, --dur-slow, --dur-tick)"""
    a, b = src.index('<style>') + 7, src.index('</style>')
    rules = css_rules(src[a:b])
    defined = set()
    for sel, body in rules:
        defined |= set(re.findall(r'(--[\w-]+)\s*:', body))
        if sel in (':root', ':root[data-theme="dark"]'):
            continue
        for m in COLOR_RX.finditer(body):
            warn(f'css: literal colour {m.group(0)} in «{sel[:60]}» (use a token from :root)')
        for m in re.finditer(r'font-size:\s*([^;]+)', body):
            v = m.group(1)
            if 'px' in v and 'var(--ts)' not in v and 'var(--fs-' not in v:
                for part in (p.strip() for p in sel.split(',')):
                    if part not in FIXED_FS:
                        warn(f'css: font-size {v.strip()} in «{part[:60]}» does not follow the text size '
                             f'(use var(--fs-*) or calc(N * var(--ts)); a fixed glyph goes into FIXED_FS)')
        for m in re.finditer(r'(?:transition|animation)(?:-duration)?:\s*([^;]+)', body):
            if DURATION_RX.search(re.sub(r'var\([^)]*\)', '', m.group(1))):
                warn(f'css: literal duration in «{sel[:60]}»: {m.group(1).strip()[:50]} (use --dur, --dur-slow or --dur-tick)')
    used = set(re.findall(r'var\((--[\w-]+)', src))
    for v in sorted(used - defined - RUNTIME_VARS):
        warn(f'css: var({v}) is used but not defined in :root')
    for m in re.finditer(r'style=\\?"([^"]*)"', src[b:]):
        if COLOR_RX.search(m.group(1)):
            warn(f'css: inline style with a colour: style="{m.group(1)[:60]}"')


def main():
    D, images, changelog, version, cache = load()
    check_parity(D)
    check_refs(D, images)
    check_triggers(D)
    check_theory(D)
    check_lessons(D)
    check_lesson_totals(D)
    check_meta(D, changelog, version, cache)
    with open(os.path.join(ROOT, 'index.html'), encoding='utf-8') as f:
        check_css(f.read())

    print(f'v{version}: {len(D["drinks_ru"])} drinks, {len(D["preps_ru"])} preps, '
          f'{len(D["vitrina_ru"])} vitrina, {len(D["promos_ru"])} promos, {len(D.get("theory_ru", []))} theory questions, {len(images)} images')
    for w in warns:
        print('WARN ', w)
    for e in errors:
        print('ERROR', e)
    print(f'{len(errors)} error(s), {len(warns)} warning(s)')
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
