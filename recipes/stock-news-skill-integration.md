---
id: stock-news-skill-integration
name: Stock News Skill Integration
version: 0.1.0
description: 把 stock-news-skill（agent 端負責抓 RSS / 爬蟲 / vendor API）串到 news-ingest pipeline。Skill 寫 JSON，adapter 吃 JSON，wikify + 寫 markdown 全自動。
category: integrate
requires: []
secrets: []
health_checks: []
setup_time: 10 min
cost_estimate: "$0 (純檔案 I/O); 視 skill 是否用 LLM 解析新聞"
---

# Stock News Skill — Integration Recipe

## 整體架構

```
你的 stock-news-skill (本地、agent driven)
    │ 抓 RSS / 爬蟲 / vendor API
    │ 寫 schema-v1 JSON
    ▼
<brain_dir>/news-raw/<YYYY-MM-DD>/<source>-<id>.json
    │
    ▼
StockNewsSkillNewsSource adapter (src/core/data-sources/)
    │ getArticles(date) → NewsArticle[]
    ▼
news-ingest handler
    │ wikify body (alias map)
    │ extract ticker_mentions for summary
    ▼
<brain_dir>/news/<YYYY-MM-DD>/*.md (with [[tickers/XXXX]])
<brain_dir>/news/<YYYY-MM-DD>/_summary.md
    │
    ▼
market-heat → daily-digest → compliance-filter → client-prep
```

## Setup（一次性，~10 分鐘）

### 1. 確認方位

確認以下目錄會被建立：

```
<brain_dir>/
├── news-raw/        ← skill 寫進來（已加入 .gitignore + gbrain.yml db_only）
├── news/            ← news-ingest 寫進來（已加入 .gitignore + gbrain.yml db_only）
└── skills/stock-news-skill/SKILL.md  ← agent 看的合約
```

`news-raw/` 已加入 `gbrain.yml` 的 `db_only` 與 `.gitignore`，不會誤 commit。

### 2. 確認 adapter 已就位

```bash
ls src/core/data-sources/stock-news-skill-news-data.ts
grep "stock-news-skill" src/core/data-sources/news-data.ts
```

兩個都該有結果。

### 3. 跑一次 sanity check（fixture）

```bash
bun test test/stock-news-skill-adapter.test.ts
```

應該全綠。

## Daily Workflow

### Phase 1: Agent 跑 stock-news-skill

Agent 看 `skills/stock-news-skill/SKILL.md`，依規則：
1. 抓今天的 RSS / 新聞 API
2. 寫 schema-v1 JSON 到 `<brain_dir>/news-raw/<date>/`

### Phase 2: News-ingest pipeline

```bash
gbrain jobs submit news-ingest \
  --params "{\"brain_dir\":\"$(pwd)\",\"date\":\"$(date +%F)\",\"source\":\"stock-news-skill\"}" \
  --idempotency-key "news-ingest-stock-news-skill:$(date +%F)" \
  --follow
```

完成後檢視：

```bash
ls news/$(date +%F)/
cat news/$(date +%F)/_summary.md
```

### Phase 3: Downstream (一條鏈跑完)

```bash
DATE="$(date +%F)"
BRAIN="$(pwd)"

# heat 合成
gbrain jobs submit market-heat \
  --params "{\"brain_dir\":\"$BRAIN\",\"date\":\"$DATE\"}" --follow

# (analyst 寫 digest at playbooks/digests/$DATE.md, OR daily-market-digest skill)

# 合規閘
gbrain jobs submit compliance-filter \
  --params "{\"brain_dir\":\"$BRAIN\",\"date\":\"$DATE\",\"llm\":true}" --follow
```

## JSON Schema（你的 skill 要寫的格式）

完整規格在 [skills/stock-news-skill/SKILL.md](../skills/stock-news-skill/SKILL.md#output-schema-v1--required-format)。
重點：

```json
{
  "schema_version": 1,
  "article_id": "<upstream-stable-id>",
  "source_name": "cnyes",
  "published_at": "2026-05-20T08:30:00+08:00",
  "title": "MLCC報價傳調漲，車用拉貨潮再起",
  "body": "naked text body — 不要 wikify",
  "url": "https://...",
  "hint_tickers": ["2327", "2492"],
  "hint_themes": ["passive-components"]
}
```

**Body 千萬不要 wikify**。Adapter 之後的 news-ingest handler 統一處理，這樣
日後改 alias map 可重跑歷史，不用重抓新聞。

## 跨 source 擴充

想加 Bloomberg / Reuters / 自家爬蟲？兩條路：

### 走同一個 adapter（最簡單）

Bloomberg 的爬蟲也寫到 `news-raw/<date>/bloomberg-<id>.json`（同樣 schema-v1
格式，差別是 `source_name: "bloomberg"`）。一個 adapter 全吃。

### 寫專屬 adapter（需要不同格式時）

新增 `src/core/data-sources/bloomberg-news-data.ts`，在
`news-data.ts:resolveNewsSource` 加 `case 'bloomberg':`。跑時：

```bash
gbrain jobs submit news-ingest --params '{...,"source":"bloomberg"}'
```

`news/` 寫入路徑不變（每個 source 都共用同一個 `news/<date>/*.md`，靠
article_id namespacing 不衝突）。

## Trust & Compliance

| Layer | 責任 |
|---|---|
| stock-news-skill (sense) | 抓 + 寫 raw JSON，**不下判斷** |
| adapter | shape validation，**malformed file 直接 skip** |
| news-ingest | wikify，extract mentions，summary |
| market-heat | 用 mention count 算 news_density 訊號 |
| daily-digest (analyst) | 引用 source，寫客觀敘事 |
| **compliance-filter** | **客戶推送前的閘** — 抓「建議買進/賣出」 |
| client-prep | pass 過的對外內容池 |

整個鏈條的 **trust boundary** 是 compliance-filter — 上游 raw news 可以包含
原始作者的立場 / 推測 / 預測，**那是 source 的聲音**，不會直接到客戶。

## Known Issues / Backlog

- [ ] 跨 source 同篇新聞 dedup（同樣事件多家報導）— 留待 news-ingest 層改寫
- [ ] 多語言處理（中文 + 英文 + 日文新聞混合 wikify）— alias map 已支援
- [ ] 圖片 OCR — 法說會簡報 / 公告圖片裡的 ticker
- [ ] PDF ingest — 賣方研報走 PDF 而非 RSS
