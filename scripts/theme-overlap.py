# -*- coding: utf-8 -*-
"""theme-overlap.py <code> [<code> ...]
給一組個股代號（新文章的候選成員），掃過所有 themes/*.md，列出有成員重疊的既有族群，
依重疊數排序。用於 news/user-data ingest 前的「去重/合併」判斷。
"""
import sys, os, re, glob, json

THEMES = r"E:\SinoBrain-data\themes"
codes_in = set(c.strip() for c in sys.argv[1:] if c.strip())
if not codes_in:
    print("usage: theme-overlap.py <code> [<code> ...]"); sys.exit(1)

m = json.load(open(r"E:\SinoBrain\src\core\entities\ticker-master.json", encoding="utf-8"))
def nm(c): return m.get(c, {}).get("name", "?")

mem_re = re.compile(r"- \[\[tickers/([^\]|]+)\]\]")
results = []
for path in glob.glob(os.path.join(THEMES, "*.md")):
    raw = open(path, encoding="utf-8").read()
    fm = re.match(r"^---\n(.*?)\n---\n", raw, re.S)
    src = "?"
    if fm:
        ms = re.search(r"^source:\s*(.+)$", fm.group(1), re.M)
        if ms: src = ms.group(1).strip()
    members = set(mem_re.findall(raw))
    shared = codes_in & members
    if shared:
        slug = "themes/" + os.path.basename(path)[:-3]
        results.append((len(shared), slug, src, len(members), sorted(shared)))

results.sort(key=lambda r: -r[0])
print(f"輸入 {len(codes_in)} 檔: {', '.join(sorted(codes_in))}")
print(f"重疊族群 {len(results)} 個:\n")
for cnt, slug, src, total, shared in results:
    sh = "、".join(f"{c}{nm(c)}" for c in shared)
    print(f"  [{cnt}/{total}] {slug}  (source={src})")
    print(f"        共有: {sh}")
