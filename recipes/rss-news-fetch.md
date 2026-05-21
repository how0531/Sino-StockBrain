---
id: rss-news-fetch
name: RSS News Fetch
version: 0.1.0
description: 真實可跑的 RSS 抓取器 — fetch RSS feed、解析 XML、寫 schema-v1 JSON 到 news-raw/。stock-news-skill sense 層的具體實作。支援 live URL 與 local file 兩種模式。
category: sense
requires: []
secrets: []
health_checks: []
setup_time: 3 min
cost_estimate: "$0 (純 HTTP + XML 解析，零 LLM)"
---

# RSS News Fetch — 真實 RSS 抓取器

stock-news-skill 的具體 sense 實作。做真的 HTTP fetch + RSS 2.0 解析，輸出
schema-v1 JSON 到 `news-raw/<date>/<source>-<id>.json`，正好是 adapter 吃的格式。

整條鏈：

```
rss-news-fetch → news-raw/*.json → (adapter) → news-ingest → news/*.md
```

## 兩種輸入模式

| 模式 | param | 用途 |
|---|---|---|
| Live | `rss_url` | 你開放網路的機器上，抓真實 feed |
| File | `rss_file` | 離線開發 / CI / 已錄製的 feed |

**剛好一個**必填（互斥）。

## Live 模式（在你的機器上）

```bash
gbrain jobs submit rss-news-fetch \
  --params "{\"brain_dir\":\"$(pwd)\",\"source_name\":\"cnyes\",\"rss_url\":\"https://news.cnyes.com/rss/cat/tw_stock\"}" \
  --follow
```

常見台股財經 RSS（你的機器能連就能抓）：

| 來源 | RSS |
|---|---|
| 鉅亨網 台股 | `https://news.cnyes.com/rss/cat/tw_stock` |
| 工商時報 | `https://ctee.com.tw/feed` |
| Yahoo 個股 | `https://feeds.finance.yahoo.com/rss/2.0/headline?s=2330.TW&region=TW&lang=zh-TW` |

> 注意：各站 RSS 路徑會變動，且須遵守該站 robots.txt / TOS。上表僅示意。

## File 模式（離線 / 測試）

```bash
gbrain jobs submit rss-news-fetch \
  --params "{\"brain_dir\":\"$(pwd)\",\"source_name\":\"cnyes\",\"rss_file\":\"test/fixtures/rss/cnyes-tw-stock-sample.xml\"}" \
  --follow
```

## 完整每日流程

```bash
BRAIN="$(pwd)"; DATE="$(date +%F)"

# 1) 抓多個來源（各跑一次，寫到同一個 news-raw/<date>/）
for src_url in \
  "cnyes|https://news.cnyes.com/rss/cat/tw_stock" \
  "commercial-times|https://ctee.com.tw/feed"; do
  IFS='|' read -r name url <<< "$src_url"
  gbrain jobs submit rss-news-fetch \
    --params "{\"brain_dir\":\"$BRAIN\",\"source_name\":\"$name\",\"rss_url\":\"$url\",\"date\":\"$DATE\"}"
done

# 2) 標準化 + wikify
gbrain jobs submit news-ingest \
  --params "{\"brain_dir\":\"$BRAIN\",\"date\":\"$DATE\",\"source\":\"stock-news-skill\"}"

# 3) 下游
gbrain jobs submit market-heat --params "{\"brain_dir\":\"$BRAIN\",\"date\":\"$DATE\"}"
gbrain sync
```

## 解析能力（src/core/data-sources/rss-parse.ts）

- ✅ RSS 2.0 `<item>` blocks
- ✅ CDATA 解開（`<![CDATA[...]]>`）— zh-TW feed 標配
- ✅ HTML tag 去除（`<p>`、`<a>` → 純文字）
- ✅ HTML entity 解碼（`&amp;` `&#65;` `&#x41;` `&nbsp;`）
- ✅ RFC-822 pubDate → ISO 8601 + Asia/Taipei 日期分桶
- ✅ article_id 從 guid / link 數字 derive，無則 hash title
- ❌ namespaced 擴充（media:、content:encoded）— 真實 feed 需要時再加
- ❌ Atom / RSS 1.0 — 同上

## 輸出格式

每篇文章寫成 schema-v1（見 `skills/stock-news-skill/SKILL.md`）：

```json
{
  "schema_version": 1,
  "article_id": "5484012",
  "source_name": "cnyes",
  "published_at": "2026-05-20T06:05:00.000Z",
  "title": "日電貿法說會：被動元件下半年能見度提升",
  "body": "通路商日電貿今日召開法說會...",
  "url": "https://...",
  "fetched_at": "2026-05-21T01:57:08.691Z"
}
```

`body` 是純文字（HTML 已去除）但**未 wikify** — wikify 在 news-ingest 統一做。

## Idempotency + Robustness

- 同 `article_id` 已存在 → skip（重跑不重抓）
- Atomic write（`.tmp` + rename）→ 不會留半寫的 JSON
- HTTP timeout 20s
- `source_name` 限 `[a-z0-9_-]+`（用於檔名，防注入）

## 把這個換成你本地的 stock-news-skill

這個 handler 是「RSS-based 抓取」的參考實作。你本地的 stock-news-skill 若用
不同方法（vendor API、爬蟲、付費 feed），只要**最終寫出同樣的 schema-v1
JSON 到 news-raw/**，下游完全一樣。兩者可並存：

```bash
# 你的 skill 寫 vendor 來源
# (your local stock-news-skill writes news-raw/<date>/vendor-*.json)

# rss-news-fetch 補 RSS 來源
gbrain jobs submit rss-news-fetch --params '{...,"source_name":"cnyes",...}'

# news-ingest 一次吃全部
gbrain jobs submit news-ingest --params '{...,"source":"stock-news-skill"}'
```
