# -*- coding: utf-8 -*-
"""把 pick-words.py 挑好的語詞（data/write-words.json）套回 write-demo.html 的 BANK。

BANK 的格式是 [注音, 筆畫, 筆順, 語詞, 部首, 語詞注音]，這支只動第 4 和第 6 欄。
先跑 pick-words.py 再跑這支。
"""
import io, json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def P(*p): return os.path.join(ROOT, *p)

html = io.open(P('write-demo.html'), encoding='utf-8').read()
m = re.search(r'(var BANK = )(\{.*?\})(;\n)', html, re.S)
BANK = json.loads(m.group(2))
NEW = json.load(io.open(P('data', 'write-words.json'), encoding='utf-8'))

changed = 0
for c, v in BANK.items():
    if c not in NEW: continue
    w, parts = NEW[c]
    if v[3] == w and v[5] == parts: continue
    v[3], v[5] = w, parts
    changed += 1

out = json.dumps(BANK, ensure_ascii=False, separators=(',', ':'))
html = html[:m.start(2)] + out + html[m.end(2):]
io.open(P('write-demo.html'), 'w', encoding='utf-8').write(html)
print('更新 %d 個字的語詞' % changed)
