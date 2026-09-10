# -*- coding: utf-8 -*-
"""產生「詞 → 每個字的注音」對照表，內嵌進 write-demo.html。

為什麼要這張表：老師的圈詞是家長自己打的，程式查不到整個詞的讀音，
只能拿字庫收的單字讀音去標，多音字就會標錯
（課文「比我還高」念ㄏㄞˊ，字庫收的是ㄏㄨㄢˊ）。
有了這張表，圈詞只要在表上就標得出正確注音；不在表上才退回「多音字不標」的規則。

兩個來源：
1. BANK 每個字配的語詞（已經過 pick-words.py 的讀音一致檢查）
2. 課本語詞表的其他詞，注音查教育部《國語辭典簡編本》

同時產生一份多音字清單 POLY：辭典收了不只一個讀音的字，這些字不在表上就不標注音。
"""
import csv, io, json, os, re, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def P(*p): return os.path.join(ROOT, *p)

raw = json.load(io.open(P('data', '教育部國語辭典簡編本_詞條注音.json'), encoding='utf-8'))
CHAR = collections.defaultdict(set)
WORD = {}
for k in raw:
    if '.' not in k: continue
    w, b = k.split('.', 1); b = b.strip()
    if re.match(r'^[一-鿿]$', w): CHAR[w].add(b)
    elif re.match(r'^[一-鿿]{2,4}$', w): WORD.setdefault(w, b)

def norm(b): return b.replace('　', '').replace(' ', '')

def split_bopo(word, full):
    """把整個詞的注音切回每個字。用每個字已知的讀音逐字咬，才處理得了破音字。"""
    rest, out = norm(full), []
    for i, ch in enumerate(word):
        cands = sorted(CHAR.get(ch, []), key=lambda x: -len(x))
        hit = None
        for r in cands:
            if rest.startswith(norm(r)): hit = r; break
        if hit is None: return None
        out.append(hit); rest = rest[len(norm(hit)):]
    return out if not rest else None

html = io.open(P('write-demo.html'), encoding='utf-8').read()
BANK = json.loads(re.search(r'var BANK = (\{.*?\});\n', html, re.S).group(1))

WB = {}
for c, v in BANK.items():                       # 來源 1：題庫語詞，已驗過讀音
    if v[3] and v[5] and len(v[3]) == len(v[5]): WB[v[3]] = v[5]

book = [r[0].strip() for r in
        csv.reader(io.open(P('data', '康軒國語_114學年_語詞解釋.csv'), encoding='utf-8'))][1:]
for w in book:                                  # 來源 2：課本語詞表的其他詞
    if not w or w in WB or w not in WORD: continue
    parts = split_bopo(w, WORD[w])
    if parts: WB[w] = parts

POLY = ''.join(sorted(c for c in CHAR if len(CHAR[c]) > 1 and c in BANK))

block = ('var WORDBOPO = ' + json.dumps(WB, ensure_ascii=False, separators=(',', ':')) + ';\n' +
         'var POLY = ' + json.dumps(POLY, ensure_ascii=False) + ';\n')
m = re.search(r'var WORDBOPO = .*?\nvar POLY = .*?;\n', html, re.S)
if m:
    html = html[:m.start()] + block + html[m.end():]
else:
    anchor = 'var LESSONS = '
    i = html.index(anchor)
    html = html[:i] + block + html[i:]
io.open(P('write-demo.html'), 'w', encoding='utf-8').write(html)
print('詞表 %d 個詞，多音字 %d 個，共 %.0f KB' % (len(WB), len(POLY), len(block)/1024))
