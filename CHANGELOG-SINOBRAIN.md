# Changelog — SinoBrain fork

SinoBrain 是 GBrain v0.37.1.0（base commit `39e14cd`）的 fork，特化成永豐金證券股市情報大腦。**這份只記 fork-specific 改動**；上游 GBrain 改動見 [CHANGELOG.md](e:/SinoBrain/CHANGELOG.md)。

格式採 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，以 sprint 為單位，最新在上。完整內容看 [docs/handoff/](e:/SinoBrain/docs/handoff/) 與 git log `feat(sino-stockbrain):`。

---

## [Sprint 1] — 2026-05-28：歸因層 + 研究報告入源

主軸：把專案從「個股維基百科」推進到「能解釋為什麼漲」 + 「能接收用戶研究」。

### Added

- **wiki-style ticker pages** 全市場 1966 檔升級為完整條目（公司基本資料 / 主要業務 / 所屬族群 / Catalysts / 大事年表）— 對應 chatbot 答「X 是做什麼的」`44b35e7`
  - 新檔 [src/core/entities/ticker-profiles.json](e:/SinoBrain/src/core/entities/ticker-profiles.json)（1978 檔 cmoney 公司基本資料）
  - 新 generator [scripts/gen-stock-profiles.py](e:/SinoBrain/scripts/gen-stock-profiles.py)
  - 重寫 [scripts/gen-ticker-pages.ts](e:/SinoBrain/scripts/gen-ticker-pages.ts)

- **`fundamentals-revenue` handler** — 月營收 snapshot per ticker + `_summary.md` + `_index.json` `c6af7e6`
  - StockDataSource 加 optional capability `getMonthlyRevenue`
  - Metabase 實作走 `cmoney."月營收(成長與達成率)"`
  - wiki「財務脈動」段第一版

- **`fundamentals-eps` handler** — 機構 EPS 預估（含**明年估**）+ `_summary.md` 直接答「明年預估 EPS 成長 Top N」`1c92c8f`
  - StockDataSource 加 `getConsensusEPS`
  - Metabase 實作走 `cmoney."月機構預估盈餘與EPS"`
  - 計算 `next_year_growth_pct = (next - current) / current` 並 pre-compute 進 JSON
  - Top-N 過濾 `analyst_count_next ≥ 3` 防一檔分析師亂估炸榜
  - wiki「財務脈動」段擴張：營收 + EPS 並列，明年機構估 bold 顯示
  - 新 helper `numOrNull()` — 區分 NaN/null 與真實 0

- **`movers-detect` handler — Phase E step 1** — 每日 Top N 漲跌幅 / 成交金額 `773a904`
  - StockDataSource 加 `getLatestQuoteDate`
  - 寫 `movers/<YYYY-MM-DD>.{json,md}`，4 碼一般股 only，漲跌停保留
  - 屬 attribution 層的入口

- **`attribution-gather` handler — Phase E step 2** — 對每個 mover 建 5-signal 證據包 `4b681cf`
  - 5 個 signal：institutional_flow / theme_rotation / news_catalyst / revenue_trigger / broker_coverage
  - 每個 0–1 啟發式 score（**未經歷史校準**，TODO）
  - institutional_flow direction-aligned：對 gainer 只計正向 net、逆勢 evidence 標「散戶推動」
  - 寫 `attribution/<date>/<code>.json` + `_hot.md`
  - 處理 top_gainers ∪ top_turnover，cap 50 ticker

- **wiki「近期動能與可能原因」段 — Phase E step 3** — gen-ticker-pages 讀 attribution JSON，渲染 top-3 candidates + narrative_hints 進每個 mover 的維基頁 `5e72d59`

- **研究報告入源 — R1 + R2** — 讓用戶寫的 md / txt 研報走既有 news pipeline `048d17a`
  - Schema 設計：`docs/research-reports.md` — 擴 schema-v1 加可選欄位 `report_kind / analyst_firm / analyst_name / recommendation / target_price / report_date / report_url / tags`
  - 新 script [scripts/ingest-research.ts](e:/SinoBrain/scripts/ingest-research.ts) — 雙寫：原始 → `research-reports/<date>/`（db_tracked），schema-v1 → `news-raw/<date>/`（db_only）
  - 新 NewsSource [src/core/data-sources/user-research-news-data.ts](e:/SinoBrain/src/core/data-sources/user-research-news-data.ts) — filter `source_name` 開頭 `user-research` / `internal-memo`
  - 新 helper [scripts/import-news-day.ts](e:/SinoBrain/scripts/import-news-day.ts) — 單日 news 目錄 scoped import

- **AI agent handoff log** `5abc695` — 新資料夾 [docs/handoff/](e:/SinoBrain/docs/handoff/) 收 19 章交接書 [2026-05-28-agent-handoff.md](e:/SinoBrain/docs/handoff/2026-05-28-agent-handoff.md)

- **分層架構 docs** `9025fd3` — PROJECT_OVERVIEW 新增第七章「分層細節（模組 ↔ 檔案）」對應 10 層架構到實際檔案

### Changed

- **三大法人補滿（外資+投信+自營自行買賣）** `8518605` — 舊版整個排除 dealer（理由：避險雜訊），現在拆 `自營商買賣超(自行買賣)` 跟 `自營商買賣超(避險)`，**只取自行買賣**保留方向性 prop bet 訊號
  - `MetabaseStockDataSource.getInstitutionalFlow` 從 2 個 query 變 3 個 parallel query
  - `twse-institutional-flow` handler markdown body 列 3 腳；header 改「三大法人買賣超」
  - `attribution-gather` evidence text 從「外資+投信」升「三大法人」
  - `net_intensity` 計算現在包含 dealer leg
  - 驗證：2330 (2026-05-27) 外資 +8.81M / 投信 +1.2k / 自營(自行) +195.8k → 強度 22.37%

### Notes

- branch ahead origin/master **13 commits**（未推 GitHub）
- 全 sprint 是「資料層 only」範圍 — chatbot UX / LLM 敘事 / 合規 rubric / 客戶認證 都不在此 sprint
- attribution score 是工程啟發式，**未經歷史校準** — 文件已標 TODO，需 60 天 Top 100 漲股 ground-truth 才能正式 weight

---

## [Sprint 0] — 2026-05-21 ~ 2026-05-26：fork 基礎打底（摘要）

不分 fine-grained sub-release，按 milestone 分組（commit 哈希在後）。

### 初始 scaffolding
- 儲存分層 (db_tracked vs db_only) + 10+6 檔 ticker 範本 `0e8d4bb`
- StockDataSource 抽象層 + mock 實作 + 三大法人 handler v1 `1a7512d`

### 圖譜核心
- self-wiring graph 第一波：news-ingest + wikify + 被動元件 watchlist `f54f5a7`
- heat-score + daily-market-digest skill — 訊號合成 pipeline `bd29efe`
- compliance filter — Layer-1 regex + Layer-2 LLM judge `f0c053a`
- 36 個 heat-score 單元測試 + e2e demo `2509b25`

### 新聞 pipeline
- stock-news-skill JSON adapter `35edfc9`
- 真實 RSS 抓取器 `da9eb37`
- stock-news-skill → graph live 走通（bridge + hint_tickers 邊）`36caa7a`

### 全市場族群與個股
- market-wide alias map (3980 keys from cmoney master) `655767a`
- 概念群 theme pages（個股 ↔ 族群圖譜層）`115f554`
- 自動生成 ticker pages（全市場圖譜）`766e562`
- 全 concept lattice + supply-chain graph 工具 `fd34779`

### wikify 護欄系列
- 砍 bare numeric code（年份、價格、電話誤連 ticker）`52950a8`
- 砍 spurious co-mention / short-name / boilerplate 邊 `c162cf6`
- Fix（圖譜）wire stock-domain dirs into auto-link + lowercase US ticker slug `248056d`

### Metabase 真實資料取代 mock
- metabase adapter for 量價 / 籌碼 + `_summary` edge-free `14076d5`
- heat-score 端到端可用 (net_intensity + news + liquidity floor) `8d3cd8c`
- 法人=外資+投信 + de-saturated heat signal + 連買 streak `cc17cee`
- 合規 client-prep 移除 internal-only note `758b9e6`

### 文件
- Windows 本地設定 + daily-run scripts `50d02f7`
- PROJECT_OVERVIEW handoff + daily-run extract step `3eac952`

---

## Fork base

- Forked at GBrain `39e14cd` (v0.37.1.0)
- Upstream GBrain 改動見 [CHANGELOG.md](e:/SinoBrain/CHANGELOG.md)
- 上游同步策略：定期 rebase 或 merge upstream main；fork 改動全在 `feat(sino-stockbrain):` / `fix(sino-stockbrain):` / `docs(sino-stockbrain):` prefix 下，方便 cherry-pick
