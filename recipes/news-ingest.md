---
id: news-ingest
name: News Ingest
version: 0.1.0
description: 拉取財經新聞，透過 ticker alias map 把純文字公司名 wikify 成 [[tickers/XXXX]]，寫入 brain，讓 graph 自動串連。是「自織關係網」的核心入口。
category: sense
requires: []
secrets: []
health_checks: []
setup_time: 5 min
cost_estimate: "$0 (mock 模式 + alias-map rewriter)"
---

# News Ingest — 自織關係網的核心

每篇新聞被 ingest 時，系統會用 deterministic 文字匹配把「國巨」、「2327」、
「Yageo」這類 mention 全部改寫成 `[[tickers/2327]]`。寫進 disk → `gbrain sync`
讀到 → auto-link 萃取器看到 `[[tickers/2327]]` → 寫一條 `mentions` edge →
graph 自己長出來。

## Why deterministic before LLM

| Layer | 方法 | 成本 | 覆蓋率 |
|---|---|---|---|
| 1 (這支 handler) | alias map + regex | $0 | 95% (在 alias 表內的) |
| 2 (next iteration) | Haiku 改寫 | ~$0.001/article | 99%+ (含長尾) |
| 3 (查詢時) | `entities/resolve.ts` 的 pg_trgm 模糊匹配 | $0 | 處理使用者問句 |

預設 layer 1。Alias 表在 `src/core/entities/ticker-aliases.ts`，加新名稱
就是加一行。等 layer 1 漏接太多時，再開 layer 2（`--params '{"rewriter":"llm"}'`，
這個 PR 還沒實作，故意 fail-loud）。

## Architecture

```
News Source (mock | future: cnyes-rss | future: customer-feed)
   ↓ NewsArticle[] with NAKED company names in body
News Ingest Handler
   ↓ wikify() — alias-map regex pass
Brain Repo:
   news/YYYY-MM-DD/<article-id>.md       ← 每篇文章，含 [[tickers/XXXX]]
   news/YYYY-MM-DD/_summary.md            ← 當日 Top 提及個股
   ↓
gbrain sync → link-extraction.ts 自動建 page_links 邊
   ↓
graph-query 立刻可走 tickers/2327 → news/* → 其他 tickers
```

## Setup

提交一個 job：

```bash
gbrain jobs submit news-ingest \
  --params "{\"brain_dir\":\"$(pwd)\",\"date\":\"today\",\"source\":\"mock\"}" \
  --idempotency-key "news-ingest:$(date +%F)" \
  --follow
```

完成後檢視：

```bash
ls news/$(date +%F)/
cat news/$(date +%F)/_summary.md
```

接著跑 `gbrain sync` 把資料吸進 brain：

```bash
gbrain sync
```

驗證 graph 已經自動串連：

```bash
gbrain graph-query tickers/2327 --depth 2
```

應該會看到 `tickers/2327` 連到當日多篇 `news/2026-XX-XX/mock-...`，
以及這些 news 又連到 `tickers/2492`、`tickers/3090` 等同主題個股。

## What Gets Wikified

範例輸入（mock 新聞 body）：

```
被動元件龍頭國巨近期傳出對車用 MLCC 客戶開出新一輪報價...
華新科、奇力新等同業亦傳跟進。
```

範例輸出（wikify 後）：

```
被動元件龍頭[[tickers/2327]] (國巨)近期傳出對車用 MLCC 客戶開出新一輪報價...
[[tickers/2492]] (華新科)、[[tickers/2456]] (奇力新)等同業亦傳跟進。
```

注意：
- 純粹是字串匹配，不會「理解」上下文
- Wikilink 後保留原文（`(國巨)`）方便人讀
- 已經是 wikilink 的部分會 skip（idempotent — 跑兩次結果一樣）

## Known Limits

- **NLP context-free** — 「2327 路公車」會被吃掉。透過收緊 alias 表或新增
  negative lookahead 可緩解；MVP 不處理。
- **Chinese has no word boundaries** — 「中國巨星」可能被切成
  「中[[tickers/2327]] (國巨)星」。Longest-match-first 排序緩解大多數案例。
- **English ticker `\b` 邊界** — `\bNVDA\b` 安全，不會吃 `NVDA-A` 的前綴。
- **大小寫**：英文公司名（"Apple"）case-insensitive；ticker code (`NVDA`)
  case-sensitive。

## Next Steps

- [ ] 接真實 RSS（鉅亨、工商、經濟日報）
- [ ] 加 LLM 改寫器 (`rewriter: 'llm'`) 處理長尾 entity
- [ ] 從 article body 自動推 `[[themes/passive-components]]` 標籤
- [ ] 加 Haiku 寫文章一句話摘要進 frontmatter `tldr:` 欄位
