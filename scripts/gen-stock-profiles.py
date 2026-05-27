#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
gen-stock-profiles.py — sibling of gen-stock-master.py, pulls the *narrative*
fields from cmoney."上市櫃公司基本資料" so gen-ticker-pages.ts can write rich
wiki-style ticker pages (公司簡介 / 主要業務 / 公司基本資料 段) without LLM.

ticker-master.json keeps the slim hot-path (code → name/industry only, loaded by
ticker-aliases.ts for wikify — wants to be small + fast). ticker-profiles.json
is the wider, optional companion (loaded only by gen-ticker-pages.ts).

Output (committed):

  src/core/entities/ticker-profiles.json
      { "2330": {
          "full_name": "...",            # 公司名稱
          "industry": "...",             # 產業名稱
          "industry_position": "...",    # 產業地位 — the gold one-liner
          "business": "...",             # 經營項目
          "focus": "...",                # 營業焦點
          "listed_date": "YYYY-MM-DD",   # 上市日期 (or 上櫃日期 if 上櫃)
          "chairman": "...", "ceo": "...", "spokesperson": "...",
          "employees": int|null, "capital_million": float|null,
          "export_ratio": float|null,    # 前年度外銷比重(%)
          "website": "...", "isin": "..."
        }, ... }

Re-run when refreshing the master (monthly cadence is fine — these fields are
slow-moving):
  . C:\\Users\\012701\\.claude\\skills\\sinopac-metabase\\scripts\\setup.ps1
  python -X utf8 E:\\SinoBrain\\scripts\\gen-stock-profiles.py
"""
import sys
import os
import json

SKILL_SCRIPTS = r"C:\Users\012701\.claude\skills\sinopac-metabase\scripts"
sys.path.insert(0, SKILL_SCRIPTS)

from metabase_client import MetabaseClient  # noqa: E402

OUT_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "src", "core", "entities")
)


def _s(v):
    if v is None:
        return ""
    s = str(v).strip()
    if s.lower() == "nan":
        return ""
    return s


def _date(v):
    """cmoney datetimes look like '1994-09-05T00:00:00Z' — keep the date part."""
    s = _s(v)
    if not s:
        return ""
    return s[:10] if len(s) >= 10 else s


def _num(v):
    s = _s(v)
    if not s:
        return None
    try:
        f = float(s)
    except ValueError:
        return None
    return f


def _int_or_none(v):
    f = _num(v)
    if f is None:
        return None
    n = int(f)
    return n if n > 0 else None  # cmoney stores 0 for "unknown", not real zero


def gen_profiles(cli):
    sql = (
        'SELECT "股票代號","公司名稱","產業名稱","產業地位","經營項目","營業焦點",'
        '"上市日期","上櫃日期","董事長","總經理","發言人","員工人數(人)",'
        '"實收資本額(百萬)","前年度外銷比重(%)","網址","國際證券編碼" '
        'FROM cmoney."上市櫃公司基本資料" '
        'WHERE "年度" = (SELECT max("年度") FROM cmoney."上市櫃公司基本資料")'
    )
    df = cli.query_df(sql, db=10)
    out = {}
    for _, r in df.iterrows():
        code = _s(r["股票代號"])
        if not code:
            continue
        listed = _date(r["上市日期"]) or _date(r["上櫃日期"])
        prof = {
            "full_name": _s(r["公司名稱"]),
            "industry": _s(r["產業名稱"]),
            "industry_position": _s(r["產業地位"]),
            "business": _s(r["經營項目"]),
            "focus": _s(r["營業焦點"]),
            "listed_date": listed,
            "chairman": _s(r["董事長"]),
            "ceo": _s(r["總經理"]),
            "spokesperson": _s(r["發言人"]),
            "employees": _int_or_none(r["員工人數(人)"]),
            "capital_million": _num(r["實收資本額(百萬)"]),
            "export_ratio": _num(r["前年度外銷比重(%)"]),
            "website": _s(r["網址"]),
            "isin": _s(r["國際證券編碼"]),
        }
        # Drop empty/None keys so the json is tighter and downstream can use
        # `key in prof` as a real signal.
        out[code] = {k: v for k, v in prof.items() if v not in (None, "")}

    path = os.path.join(OUT_DIR, "ticker-profiles.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=0, sort_keys=True)
    print("ticker-profiles.json: %d profiles -> %s" % (len(out), path))


def main():
    cli = MetabaseClient()
    gen_profiles(cli)


if __name__ == "__main__":
    main()
