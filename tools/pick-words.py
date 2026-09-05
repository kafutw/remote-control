# -*- coding: utf-8 -*-
"""替題庫裡每個生字挑一個「看得懂的語詞」當填空線索，並附上兩個字的注音。

規則（順序就是優先度）：
1. 課本語詞優先——那是他這一課真的學過的
2. 課本沒有的，從教育部《國語辭典簡編本》挑兩字詞
3. 硬性檢查：選到的詞裡，那個字的讀音必須跟課本一致
   （不擋的話會出現「注音 ㄉㄡ、語詞 國都(ㄉㄨ)」這種自相矛盾的題）
4. 挑詞時偏好「搭配的字越早年級學過越好」，小孩才讀得出來
"""
import csv, io, json, re, collections, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def P(*p): return os.path.join(ROOT, *p)

# ── 字典：單字讀音 + 兩字詞條 ──
raw = json.load(io.open(P('data', '教育部國語辭典簡編本_詞條注音.json'), encoding='utf-8'))
CHAR_BOPO = collections.defaultdict(set)
WORDS = {}
for k in raw:
    if '.' not in k: continue
    w, b = k.split('.', 1)
    b = b.strip()
    if re.match(r'^[一-鿿]$', w): CHAR_BOPO[w].add(b)
    elif len(w) == 2 and re.match(r'^[一-鿿]{2}$', w): WORDS.setdefault(w, b)

def norm(b): return b.replace('　', '').replace(' ', '')

def split_bopo(word, full):
    """把整個詞的注音切回每個字。用該字已知的讀音去試前綴，才處理得了破音字。"""
    full = norm(full)
    a, b = word[0], word[1]
    for ra in sorted(CHAR_BOPO.get(a, []), key=lambda x: -len(x)):
        ra_n = norm(ra)
        if full.startswith(ra_n):
            rest = full[len(ra_n):]
            for rb in CHAR_BOPO.get(b, []):
                if norm(rb) == rest: return [ra, rb]
            if rest: return [ra, rest]
    half = len(full) // 2
    return [full[:half], full[half:]]

def main():
    html = io.open(P('write-demo.html'), encoding='utf-8').read()
    BANK = json.loads(re.search(r'var BANK = (\{.*?\});\n', html, re.S).group(1))
    LESSONS = json.loads(re.search(r'var LESSONS = (\[.*?\]);\n', html, re.S).group(1))

    order = {}                       # 這個字第幾個學到（年級*10+學期），越小越早
    for L in LESSONS:
        for c in L[4]: order.setdefault(c, L[0] * 10 + L[1])

    by_char = collections.defaultdict(list)
    for w in WORDS:
        for ch in w: by_char[ch].append(w)

    def bopo_of(ch):
        return norm(BANK[ch][0]) if ch in BANK else None

    def ok_reading(word, ch):
        """詞裡那個字的讀音要跟課本一致"""
        want = bopo_of(ch)
        if not want: return False
        parts = split_bopo(word, WORDS[word])
        return norm(parts[word.index(ch)]) == want

    # 小學生真的會講的組合方式，優先挑這幾種
    GOOD_PREFIX = ('一', '好', '大', '小', '很', '這', '那')
    GOOD_SUFFIX = ('們', '子', '兒', '了', '上', '下', '裡', '到', '住', '過')

    def rank(word, ch):
        i = word.index(ch)
        other = word[1 - i]
        bonus = 0
        if word[0] == word[1]: bonus = 2                  # 疊字交給手動清單，規則別亂挑（會挑出「再再」）
        elif i == 1 and word[0] in GOOD_PREFIX: bonus = -2  # 一隻、好玩、很多
        elif i == 0 and word[1] in GOOD_SUFFIX: bonus = -2  # 你們、找到、拉住
        return (bonus,
                order.get(other, 99),            # 搭配的字越早學越好
                0 if other in BANK else 1,       # 在題庫裡的更好
                i, word)

    out, filled, manual, still = {}, 0, 0, []
    HAND = {  # 字典沒有兩字詞條的虛詞，手動指定
        '這':'這裡','誰':'誰的','您':'您好','很':'很多','嗎':'好嗎','仍':'仍然',
        '飄':'飄動','棵':'一棵','踮':'踮腳','揉':'揉眼','披':'披上','踩':'踩到',
        '拖':'拖地','瑪':'瑪瑙','搓':'搓手','遍':'一遍','艘':'一艘','粿':'紅粿',
        '眨':'眨眼','蹼':'腳蹼','咧':'咧嘴','嘟':'嘟嘴','唷':'好唷','喲':'好喲',
        # 字典查得到詞、但讀音跟課本對不上，或沒有兩字詞條的，逐字指定
        '它':'它們','都':'都是','膜':'耳膜','砰':'砰砰','輛':'車輛','隼':'遊隼',
        '鏽':'生鏽','赭':'赭色','摘':'摘下','粥':'白粥','舔':'舔嘴','濺':'濺起',
        '嗯':'嗯嗯','魏':'魏國','楓':'楓葉','拴':'拴住','萊':'蓬萊','郭':'城郭',
        '蚵':'蚵仔','嬸':'嬸嬸','碧':'碧綠','槳':'船槳',
        # 規則挑出來太文言的，改成小學會用的
        '找':'找到','隻':'一隻','拉':'拉住','就':'就要','才':'才能','向':'向前',
        '菜':'青菜','都':'都是','再':'再見','去':'回去','把':'把手','像':'好像',
        '更':'更好','它':'它們','從':'從前','那':'那裡','又':'又來','做':'做事',
        '裡':'哪裡','脫':'脫下','皆':'皆是','悟':'領悟','入':'進入','正':'正在',
        '舌':'舌頭','讓':'讓開','撞':'撞到','恍':'恍神','率':'率先','即':'立即',
    }

    for c, v in BANK.items():
        if c in HAND:                             # 手動指定最優先，規則挑不贏它
            out[c] = HAND[c]; manual += 1
            continue
        cands = [x for x in by_char.get(c, []) if ok_reading(x, c)]
        w = v[3]
        # 課本語詞優先，但四字以上的成語（左思右想、放之四海而皆準）對小孩太難，
        # 字典裡有兩字詞就換掉
        if w and c in w and (len(w) <= 3 or not cands):
            out[c] = w
            continue
        if cands:
            out[c] = sorted(cands, key=lambda x: rank(x, c))[0]; filled += 1
        else:
            still.append(c)

    # 每個詞配上兩個字的注音
    result = {}
    for c, w in out.items():
        if w in WORDS:
            parts = split_bopo(w, WORDS[w])
        else:
            parts = [BANK[x][0] if x in BANK else (sorted(CHAR_BOPO.get(x, ['']))[0]) for x in w]
        if len(parts) != len(w):
            parts = [BANK[x][0] if x in BANK else '' for x in w]
        # 目標字的讀音一律以課本為準——題目上面標的注音就是它，兩處不能不一樣
        parts[w.index(c)] = BANK[c][0]
        result[c] = [w, parts]

    io.open(P('data', 'write-words.json'), 'w', encoding='utf-8').write(
        json.dumps(result, ensure_ascii=False, indent=0))
    print('課本原有 %d，字典補 %d，手動補 %d，仍然沒有 %d' %
          (len(BANK) - filled - manual - len(still), filled, manual, len(still)))
    if still: print('沒補到：', ''.join(still))

if __name__ == '__main__':
    main()
