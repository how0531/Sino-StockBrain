#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
gen-stock-master.py — generate SinoBrain's ticker master + concept-group data
files from the company Metabase, by REUSING the sinopac-metabase skill's client
(so auth / token-cache / UTF-8 are all handled there, not reinvented here).

Outputs (committed; loaded by src/core/entities/ticker-aliases.ts + Layer B
theme-page generator):

  src/core/entities/ticker-master.json
      { "2330": {"name","abbr","en","market","industry"}, ... }   (all listed TWSE+TPEX)

  src/core/entities/concept-groups.json
      [ {"tag": "...", "codes": ["2330", ...]}, ... ]              (statementdog, market=TW)

Re-run monthly to refresh:
  . C:\\Users\\012701\\.claude\\skills\\sinopac-metabase\\scripts\\setup.ps1
  python -X utf8 E:\\SinoBrain\\scripts\\gen-stock-master.py
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
    """Stringify a cell, treating NaN/None/'NaN' as empty."""
    if v is None:
        return ""
    s = str(v).strip()
    if s.lower() == "nan":
        return ""
    return s


def gen_ticker_master(cli):
    sql = (
        'SELECT "股票代號","股票名稱","中文簡稱","英文簡稱","上市上櫃","產業名稱" '
        'FROM cmoney."上市櫃公司基本資料" '
        'WHERE "年度" = (SELECT max("年度") FROM cmoney."上市櫃公司基本資料")'
    )
    df = cli.query_df(sql, db=10)
    master = {}
    for _, r in df.iterrows():
        code = _s(r["股票代號"])
        if not code:
            continue
        name = _s(r["股票名稱"]) or _s(r["中文簡稱"])
        if not name:
            continue
        master[code] = {
            "name": name,
            "abbr": _s(r["中文簡稱"]),
            "en": _s(r["英文簡稱"]),
            "market": _s(r["上市上櫃"]),     # cmoney code: 1=上市(TWSE) / 2=上櫃(TPEX) ...
            "industry": _s(r["產業名稱"]),
        }
    path = os.path.join(OUT_DIR, "ticker-master.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(master, f, ensure_ascii=False, indent=0, sort_keys=True)
    print("ticker-master.json: %d stocks -> %s" % (len(master), path))
    return master


def gen_concept_groups(cli):
    sql = (
        "SELECT tag, code FROM public.concept_stocks "
        "WHERE source='statementdog' AND market='TW'"
    )
    df = cli.query_df(sql, db=10)
    groups = {}
    for _, r in df.iterrows():
        tag = _s(r["tag"])           # NOTE: many tags have trailing spaces -> strip()
        code = _s(r["code"])
        if not tag or not code:
            continue
        groups.setdefault(tag, set()).add(code)
    out = [{"tag": t, "codes": sorted(c)} for t, c in sorted(groups.items())]
    path = os.path.join(OUT_DIR, "concept-groups.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=0)
    print("concept-groups.json: %d tags -> %s" % (len(out), path))
    return out


def main():
    cli = MetabaseClient()  # reads METABASE_USER/PASS/URL from env (see setup.ps1)
    gen_ticker_master(cli)
    gen_concept_groups(cli)


if __name__ == "__main__":
    main()
