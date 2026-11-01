#!/usr/bin/env python3
"""Import the approved theory questions into index.html.

The question bank lives in the trainer's Google Sheet «Sensum Обучение: банк
вопросов» (folder «Sensum Обучение» on Google Drive). Export two ranges of it as
the JSON the Sheets connector returns ({"range": ..., "values": [[...]]}):

    'Вопросы'!A1:T<last row>   ->  questions.json
    'Темы'!A1:E<last row>      ->  topics.json

then:

    python3 tools/theory.py questions.json topics.json

Only rows with the status «Утверждено» are imported. The script checks them
(RU and AZ side by side, the answer key, the topic) and rewrites the theory keys
of the DATA literal in index.html: theory_ru / theory_az (questions),
tdirs_ru / tdirs_az (directions) and ttopics_ru / ttopics_az (topics). Nothing
else in DATA changes. Run tools/release.py afterwards.

Question shape (the language-neutral fields are identical in RU and AZ):
    {id, topic, lvl, type, q, opts, ans}
    type  one    one right option          ans = index of it
          multi  several right options     ans = sorted indexes
          order  put the options in order  ans = indexes in the right order
          num    type a number             ans = the number, no opts
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(ROOT, 'index.html')

HEADER = ['ID', 'Код темы', 'Направление', 'Уровень', 'Тип', 'Вопрос (RU)', 'A (RU)', 'B (RU)', 'C (RU)', 'D (RU)',
          'Вопрос (AZ)', 'A (AZ)', 'B (AZ)', 'C (AZ)', 'D (AZ)', 'Ответ', 'Источник', 'Номер в экзамене', 'Статус',
          'Комментарий']
TOPIC_HEADER = ['Код темы', 'Направление', 'Тема (RU)', 'Тема (AZ)']
APPROVED = 'Утверждено'
LEVELS = {'Стажёр': 'trainee', 'Бариста': 'barista', 'Старший': 'senior'}
TYPES = {'Один ответ': 'one', 'Несколько ответов': 'multi', 'По порядку': 'order', 'Число': 'num'}
# direction = the part of the topic code before the dash; the order here is the order of the chips in the app
DIRS = [('CF', 'Qəhvə: nəzəriyyə'), ('SV', 'Servis və satış'), ('SN', 'Sanitariya və barda iş'), ('BR', 'SENSUM brendi')]
errors = []


def err(msg):
    errors.append(msg)


def text(row, i):
    v = row[i] if i < len(row) else ''
    return str(v).strip()


def letters(s):
    return [x.strip().upper() for x in re.split(r'[,\s;]+', s) if x.strip()]


def parse_question(row):
    qid = text(row, 0)
    lvl = LEVELS.get(text(row, 3))
    typ = TYPES.get(text(row, 4))
    if not lvl:
        err(f'{qid}: unknown level "{text(row, 3)}"')
    if not typ:
        err(f'{qid}: unknown type "{text(row, 4)}"')
        return None
    out = {}
    for lang, start in (('ru', 5), ('az', 10)):
        q = text(row, start)
        opts = [text(row, start + k) for k in range(1, 5)]
        if not q:
            err(f'{qid}: empty {lang.upper()} question')
        if typ == 'num':
            if any(opts):
                err(f'{qid}: a numeric question must have no options ({lang.upper()})')
            opts = None
        else:
            if not all(opts):
                err(f'{qid}: {lang.upper()} needs four options')
            if len(set(opts)) != len(opts):
                err(f'{qid}: {lang.upper()} options repeat')
        out[lang] = {'q': q, 'opts': opts}
    raw = row[15] if len(row) > 15 else ''
    if typ == 'num':
        try:
            ans = float(str(raw).replace(',', '.').replace(' ', ''))
            ans = int(ans) if ans == int(ans) else ans
        except ValueError:
            err(f'{qid}: the answer "{raw}" is not a number')
            ans = None
    else:
        ls = letters(str(raw))
        bad = [x for x in ls if x not in 'ABCD' or len(x) != 1]
        if bad or not ls:
            err(f'{qid}: bad answer key "{raw}"')
            ans = None
        else:
            idx = ['ABCD'.index(x) for x in ls]
            if len(set(idx)) != len(idx):
                err(f'{qid}: the answer key repeats a letter: "{raw}"')
            if typ == 'one' and len(idx) != 1:
                err(f'{qid}: «Один ответ» needs one letter, got "{raw}"')
            if typ == 'multi' and len(idx) < 2:
                err(f'{qid}: «Несколько ответов» needs two or more letters, got "{raw}"')
            if typ == 'order' and sorted(idx) != [0, 1, 2, 3]:
                err(f'{qid}: «По порядку» needs all four letters, got "{raw}"')
            ans = idx[0] if typ == 'one' else sorted(idx) if typ == 'multi' else idx
    return {'id': qid, 'topic': text(row, 1), 'lvl': lvl, 'type': typ, 'ans': ans, 'lang': out}


def load(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)['values']


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


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    qrows, trows = load(sys.argv[1]), load(sys.argv[2])
    if [h.strip() for h in qrows[0][:len(HEADER)]] != HEADER:
        print('The question sheet has different columns than this script expects; check the export range (A1:T…).')
        return 1
    if [h.strip() for h in trows[0][:len(TOPIC_HEADER)]] != TOPIC_HEADER:
        print('The topic sheet has different columns than this script expects (A1:E…).')
        return 1

    topics = {text(r, 0): (text(r, 1), text(r, 2), text(r, 3)) for r in trows[1:] if text(r, 0)}
    parsed = []
    seen = set()
    for row in qrows[1:]:
        if not text(row, 0) or text(row, 18) != APPROVED:
            continue
        if text(row, 0) in seen:
            err(f'{text(row, 0)}: duplicate id')
        seen.add(text(row, 0))
        p = parse_question(row)
        if p:
            if p['topic'] not in topics:
                err(f'{p["id"]}: unknown topic "{p["topic"]}"')
            elif p['topic'].split('-')[0] not in dict(DIRS):
                err(f'{p["id"]}: topic "{p["topic"]}" has no direction in DIRS')
            for lang in ('ru', 'az'):
                for s in [p['lang'][lang]['q']] + (p['lang'][lang]['opts'] or []):
                    if re.search(r'</?script|<!--', s, re.I):
                        err(f'{p["id"]}: markup in text')
            parsed.append(p)
    if errors:
        print('\n'.join('ERROR ' + e for e in errors))
        return 1
    if not parsed:
        print('No approved questions.')
        return 1

    dir_names = {}
    for code, az in DIRS:
        ru = next((t[0] for k, t in topics.items() if k.split('-')[0] == code), None)
        if ru:
            dir_names[code] = (ru, az)
    used = sorted({p['topic'] for p in parsed},
                  key=lambda k: ([c for c, _ in DIRS].index(k.split('-')[0]), int(k.split('-')[1])))
    parsed.sort(key=lambda p: (used.index(p['topic']), p['id']))

    new = {}
    for lang, li in (('ru', 0), ('az', 1)):
        qs = []
        for p in parsed:
            o = {'id': p['id'], 'topic': p['topic'], 'lvl': p['lvl'], 'type': p['type'], 'q': p['lang'][lang]['q']}
            if p['lang'][lang]['opts'] is not None:
                o['opts'] = p['lang'][lang]['opts']
            o['ans'] = p['ans']
            qs.append(o)
        new['theory_' + lang] = qs
        new['tdirs_' + lang] = {c: dir_names[c][li] for c, _ in DIRS if c in dir_names and any(k.startswith(c + '-') for k in used)}
        new['ttopics_' + lang] = {k: topics[k][1 + li] for k in used}

    with open(INDEX, encoding='utf-8') as f:
        src = f.read()
    a, b = find_data(src)
    raw = src[a:b]
    data = json.loads(raw)
    if dump(data) != raw:
        print('DATA does not round-trip through JSON unchanged; refusing to rewrite it.')
        return 1
    for k in list(data):
        if k.startswith(('theory_', 'tdirs_', 'ttopics_')):
            del data[k]
    data.update(new)
    out = src[:a] + dump(data) + src[b:]
    with open(INDEX, 'w', encoding='utf-8') as f:
        f.write(out)
    by_type = {}
    for p in parsed:
        by_type[p['type']] = by_type.get(p['type'], 0) + 1
    print(f'{len(parsed)} questions in {len(used)} topics: {by_type}; index.html {len(src)//1024} -> {len(out)//1024} KB')
    return 0


if __name__ == '__main__':
    sys.exit(main())
