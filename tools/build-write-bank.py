# -*- coding: utf-8 -*-
"""產生「看注音寫字」的題庫。
   來源：康軒逐課彙總 CSV（課次與生字）＋ chinese.html 的 DICT（教育部注音/部首/筆畫）
        ＋ 全字庫台灣筆順序列。輸出一個給 write-demo.html 內嵌的 JS 檔。"""
import csv, io, re, json, collections, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def path(*p): return os.path.join(ROOT, *p)

# 1) 教育部字典：字 → 注音、部首、總筆畫
html = io.open(path('chinese.html'), encoding='utf-8').read()
raw = html[html.index("var DICT = '") + len("var DICT = '"):]
raw = raw[:raw.index("'")]
DICT = {}
for ent in raw.split(';'):
    p = ent.split('|')
    if len(p) >= 3:
        head = p[0]
        DICT[head[0]] = {'b': head[1:], 'r': p[1], 's': int(p[2])}

# 2) 全字庫台灣筆順
ORDER = {}
for ent in io.open(path('data', '台灣筆順_全字庫.txt'), encoding='utf-8').read().split(';'):
    if ent: ORDER[ent[0]] = ent[1:]

# 3) 語詞（逐課彙總 + 語詞解釋），給每個字挑一個最短的當填空線索
words = set()
rows = list(csv.DictReader(io.open(path('data', '康軒國語_114學年_逐課彙總.csv'), encoding='utf-8-sig')))
for r in rows:
    for w in r['語詞'].split('、'):
        if w.strip(): words.add(w.strip())
for r in csv.DictReader(io.open(path('data', '康軒國語_114學年_語詞解釋.csv'), encoding='utf-8-sig')):
    w = (r.get('語詞') or '').strip()
    if w: words.add(w)
byChar = collections.defaultdict(list)
for w in words:
    for ch in w: byChar[ch].append(w)

GRADE = {'一年級':1,'二年級':2,'三年級':3,'四年級':4,'五年級':5,'六年級':6}
TERM  = {'上學期':1,'下學期':2}

bank, lessons, skipped = {}, [], []
for r in rows:
    g, t = GRADE[r['年級']], TERM[r['學期']]
    k = int(re.sub(r'\D', '', r['課次']) or 0)
    name = re.sub(r'^第[一二三四五六七八九十]+課[：:]\s*', '', r['課名'])
    zi = [c for c in r['生字'].replace('、', '') if c.strip()]
    use = []
    for c in zi:
        d, od = DICT.get(c), ORDER.get(c)
        if not d or not od:            # 沒注音或沒筆順就不能出題
            skipped.append(c); continue
        cand = sorted(byChar.get(c, []), key=lambda w: (len(w), w))
        hint = cand[0] if cand else ''
        bank[c] = [d['b'], d['s'], od, hint, d['r']]
        use.append(c)
    if use:
        lessons.append([g, t, k, name, ''.join(use)])

lessons.sort(key=lambda x: (x[0], x[1], x[2]))
out = ('/* 自動產生，勿手改。來源見 tools/build-write-bank.py */\n'
       'var BANK = ' + json.dumps(bank, ensure_ascii=False, separators=(',', ':')) + ';\n'
       'var LESSONS = ' + json.dumps(lessons, ensure_ascii=False, separators=(',', ':')) + ';\n')
io.open(path('data', 'write-bank.js'), 'w', encoding='utf-8').write(out)

print('課數 %d，可出題的字 %d' % (len(lessons), len(bank)))
print('沒有語詞、改用部首當線索的：%d' % sum(1 for v in bank.values() if not v[3]))
print('跳過（缺注音或筆順）：%d %s' % (len(set(skipped)), sorted(set(skipped))[:10]))
print('檔案大小 %.1f KB' % (len(out.encode('utf-8')) / 1024))
