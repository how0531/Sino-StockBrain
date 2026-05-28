# SinoBrain — AI Agent 交接書

> 你是接手這個專案的 AI 開發者。讀完這份你應該能對齊：**為什麼這顆腦長這樣、
> 不要動的決策、可以動的範圍、下一步該怎麼走**。對該寫程式碼的細節，這份指
> 你去看正確的 file:line，不重複貼程式。

**前置閱讀**：先讀 [docs/PROJECT_OVERVIEW.md](e:/SinoBrain/docs/PROJECT_OVERVIEW.md)（給人看的版本），再回來讀這份（給你看的版本）。

---

## 0. 一句話定位

**SinoBrain = 永豐金證券股市情報大腦**：fork 自 [GBrain](https://github.com/garrytan/gbrain) v0.37.1.0 的自織知識圖譜系統，特化成「公司事實 + 動能歸因 + 研究報告」的資料層，餵給機構客戶 chatbot。

**最重要的 scope 邊界**（不要踩過）：
- ✅ 你管：資料抓取 / 標準化 / 圖譜建構 / 內容組織 / 監控
- ❌ 你不管：chatbot UX、LLM prompt 設計、合規 rubric 法務簽核、客戶認證、計費

陳述目標：「**讓 chatbot 拿到的資料是「有、新、對」**」。其他層由別人負責。

---

## 1. 兩處目錄

| 路徑 | 內容 | git? |
|---|---|---|
| [E:\SinoBrain](e:/SinoBrain/) | 程式碼 (handlers / generators / docs) | ✅ `github.com/how0531/Sino-StockBrain` 上 |
| [E:\SinoBrain-data](e:/SinoBrain-data/) | 大腦內容 (tickers / themes / news / prices…) | ❌ 不在 git，子目錄分 db_tracked vs db_only |
| `~/.gbrain/brain.pglite` | 實際 PGLite DB | ❌ 本機 single-writer，Claude Desktop MCP serve 跑著時會鎖 |

Runtime：`C:\Users\012701\.bun\bin\bun.exe`。**不在 PATH**，要用全路徑。

---

## 2. 10 層架構（最權威的心智模型）

詳細參見 [PROJECT_OVERVIEW.md §七](e:/SinoBrain/docs/PROJECT_OVERVIEW.md)。簡表：

```
① 輸入層       src/core/data-sources/    StockDataSource / NewsSource 介面 + 多實作
② 抓取層       src/core/minions/handlers/ 9 個 handler (rss / quotes / flow / revenue / eps / news-ingest / market-heat / movers / attribution / compliance)
③ 入庫層       src/core/entities/         alias map + wikify 護欄
④ 圖譜層       gbrain engine (上游)       import → extract links → PGLite
⑤ 內容層       E:\SinoBrain-data/         tickers (1982) / themes (339) / sectors (3) / playbooks / client-prep
⑥ 訊號層       src/core/heat-score/       net_intensity + 連買 streak + 新聞密度
               src/core/compliance/       regex + LLM judge (Layer-1 + Layer-2)
⑦ 產出層       skills/                    daily-market-digest skill (LLM-driven)
⑧ 推送層       client-prep/ + gbrain serve MCP
⑨ 工具層       scripts/                   gen-stock-master / gen-stock-profiles / gen-concept-themes / gen-ticker-pages / ingest-research / news-from-skill / daily-run.ps1
⑩ 配置層       gbrain.yml / recipes/      storage 分區 + handler 使用說明
```

**關鍵原則：disk-coupled pipeline**。每個 handler 從 disk 找上游產物（路徑約定 = 介面），不靠 in-memory call chain。優點：handler 獨立可重跑、可重排；缺點：disk schema 一旦改要動多處。

---

## 3. 資料源（cmoney metabase, db=10 ClickHouse）

由 [src/core/data-sources/metabase-stock-data.ts](e:/SinoBrain/src/core/data-sources/metabase-stock-data.ts) 統一封裝。所有表都在 cmoney schema，中文識別碼**必須**雙引號。

| 用途 | cmoney 表 | 對應 handler / generator |
|---|---|---|
| 量價 | `日收盤表排行` | twse-daily-quotes |
| 三大法人 | `日外資持股與排行` + `日投信明細與排行` + `日自營商進出排行`（自行買賣 only）| twse-institutional-flow |
| 月營收 | `月營收(成長與達成率)` | fundamentals-revenue |
| 機構 EPS 估 | `月機構預估盈餘與EPS` | fundamentals-eps |
| 公司基本資料 | `上市櫃公司基本資料` | gen-stock-master.py + gen-stock-profiles.py |
| 概念族群 | `public.concept_stocks` (source=statementdog) | gen-stock-master.py |
| 證券市場新聞 | `證券市場新聞` | stock-news-skill (外部 python skill) |

**已知死表 / 不要用**：
- `mops.announcement`：停更 2025-02，重大訊息找它得不到新資料

**永遠中文識別碼用雙引號**：`SELECT "股票代號","公司名稱" FROM cmoney."上市櫃公司基本資料"`。

---

## 4. wikify — 文字 → 圖譜的唯一入口（最重要的一段）

位置：[src/core/entities/ticker-aliases.ts](e:/SinoBrain/src/core/entities/ticker-aliases.ts) + 在 [news-ingest.ts](e:/SinoBrain/src/core/minions/handlers/news-ingest.ts) 裡執行。

### 4.1 alias map 來源
- `ticker-master.json` (1976 檔，從 cmoney `上市櫃公司基本資料` 抓)：code → {name, abbr, en, market, industry}
- `ticker-profiles.json` (1978 檔)：寬欄位（董事長/業務/上市日/實收資本/網址…）— gen-ticker-pages.ts 讀
- 手 curated US ticker overrides（TSMC/Foxconn/Yageo + nvda/aapl/...）
- 規模：3980 個 alias key

### 4.2 護欄（每個都因為踩過坑而加，不要拿掉）

| 護欄 | 防什麼 | 位置 |
|---|---|---|
| `SAFE_SHORT_NAMES` allow-list | 2-字 CJK 名擋擋（統一/大同/中華 是 common word）；只 21 檔「鴻海/台塑/南亞/中鋼/友達/智邦/欣興/群創…」開放 | ticker-aliases.ts |
| 不 wikify bare numeric codes | `2025` 是年份不是千興、`8299` 是電話不是群聯 | ticker-aliases.ts |
| Nested-link PUA token mask | 防新建的 `[[tickers/2454]] (聯發` 又被 `1459` (聯發) match 變 `[[tickers/2454]] ([[tickers/1459]] (聯發)科)` | ticker-aliases.ts |
| `FANOUT_CAP = 8` | 一篇文章 >8 個 ticker → 整篇 broad_listing 不 wikify（防大盤回顧把 20 檔 clique 串起來） | news-ingest.ts |
| `stripDisclaimerTail` | 「免責聲明」「投顧」尾部 → 防券商自我提及、APP-ad 套用 | news-ingest.ts |

**鐵則**：改任何 wikify 規則 → 砍 `~/.gbrain/brain.pglite` → re-import → re-extract。因為 **`extract links` 只加邊、不刪邊**，舊邊不會被洗掉。

---

## 5. 圖譜 — gbrain engine 的關鍵動作

```
gbrain import <dir>            → 載入 markdown 頁到 PGLite
gbrain extract links --source db → 掃所有頁面的 [[]] 建 typed edge ← 關鍵
gbrain graph-query <slug> --direction in|out --depth N
gbrain serve                   → MCP server 給 Claude Desktop 用
```

### 5.1 import 跟 extract 的關係（最常踩錯的事）
- `import` 只匯入頁面，**不建邊**
- `extract` 建邊，但只**新增**不刪除
- 改 wikify 規則 OR 改頁面內容 wikilinks → import + extract，舊邊還在
- **要清乾淨 = 砍 pglite → import → extract**

### 5.2 reimport-graph-pages.ts 的存在原因
- `gbrain import <root>` 會走 root 下**所有**檔，但 `gbrain.yml` 的 db_only 不被 walker 排除
- 直接 `gbrain import E:\SinoBrain-data` 會吃進 43k 個 prices/flow snapshot
- 所以 [scripts/reimport-graph-pages.ts](e:/SinoBrain/scripts/reimport-graph-pages.ts) 用 `importFromFile` 一次只灌 `tickers/ themes/ sectors/`

### 5.3 fork 在 gbrain engine 的改動
**只一行**：[src/core/link-extraction.ts](e:/SinoBrain/src/core/link-extraction.ts) 的 `DIR_PATTERN` 把 tickers/sectors/themes 納入掃描範圍。其他全是上游 GBrain。

---

## 6. 內容層 storage 分區（不能搞錯）

由 [gbrain.yml](e:/SinoBrain/gbrain.yml) 與 [E:\SinoBrain-data\gbrain.yml](e:/SinoBrain-data/gbrain.yml) 雙份配置（後者是 brain root 的覆蓋）。

| 分區 | 寫入者 | 例子 | git? |
|---|---|---|---|
| **db_tracked** | 人寫 | tickers / themes / sectors / playbooks / client-prep / **research-reports** | ✅ 進 git |
| **db_only** | 機器寫，regenerable | prices / institutional-flow / fundamentals / news-raw / news / **movers** / **attribution** | ❌ DB 還原 |

**規則**：handler 新增的目錄絕大多數是 db_only（regenerable from source）。研究報告例外，是用戶寫的，db_tracked。

---

## 7. Handler 目錄（src/core/minions/handlers/）

所有 handler 接 `MinionJobContext`，在 [src/commands/jobs.ts](e:/SinoBrain/src/commands/jobs.ts) 註冊。每個 handler 有對應的 [recipes/<name>.md](e:/SinoBrain/recipes/) 使用說明。

| Handler | Output 目錄 | Capability-gated? | 用途 |
|---|---|---|---|
| `rss-news-fetch` | news-raw/ | 不需 | HTTP 抓 RSS feed |
| `twse-daily-quotes` | prices/twse/ | source: mock / twse-openapi / metabase | 每日 OHLCV |
| `twse-institutional-flow` | institutional-flow/twse/ | metabase 限定有真資料 | **三大法人**（外資+投信+自營自行買賣） |
| `fundamentals-revenue` | fundamentals/revenue/ | metabase | 月營收 + _summary + _index.json |
| `fundamentals-eps` | fundamentals/eps/ | metabase | **機構 EPS 預估**（含明年估）+ _summary + _index.json |
| `news-ingest` | news/ | source: mock / stock-news-skill / **user-research** | wikify news-raw → wikified markdown |
| `market-heat` | playbooks/heat/ | 不需 | heat_score 合成 |
| `movers-detect` | movers/ | metabase | **Phase E step 1** — 每日 Top N 漲跌 / 量 |
| `attribution-gather` | attribution/ | metabase | **Phase E step 2** — 5-signal evidence pack |
| `compliance-filter` | client-prep/ or playbooks/violations/ | 不需（需 LLM key） | 兩層合規 |

### 7.1 Handler 撰寫 pattern

照既有的 `fundamentals-eps.ts` 抄即可。所有 handler 共通模式：

1. `validateParams` — 在 handler 開頭，throws `UnrecoverableError` 對非法 input
2. `resolveStockDataSource` 取 dataSource（若需資料源）
3. **capability gate** — 如 `if (typeof dataSource.getX !== 'function') return { status: 'skipped', ... }`
4. 取資料 → 處理 → 寫 markdown + _summary.md + **_index.json**
5. per-file **skip-if-exists**（idempotent）；`_summary.md` 跟 `_index.json` 永遠 overwrite
6. 在 `jobs.ts` 註冊；在 `recipes/` 加說明
7. 在 `gbrain.yml` 加目錄到 db_only（除非真要進 git）

**`_index.json` convention（重要）**：handler 寫 per-ticker 的 `.md` 之外，也寫一份機讀的 `_index.json` `{ ymDir, source, by_ticker: { code → record } }`。下游 generator（gen-ticker-pages.ts）讀這個就不用 parse 1900 個 frontmatter。

---

## 8. Generator scripts (scripts/)

非 cron-driven、由你手跑或 daily-run 包進去的工具。

| Script | 寫什麼 | 何時跑 |
|---|---|---|
| `gen-stock-master.py` (python) | `src/core/entities/ticker-master.json` + `concept-groups.json` | 月度 refresh |
| `gen-stock-profiles.py` (python) | `src/core/entities/ticker-profiles.json`（寬欄位） | 月度 |
| `gen-concept-themes.ts` (bun) | `<brain>/themes/<slug>.md`（題材族群成分頁，~339 個） | gen-ticker-pages 之前必跑 |
| `gen-ticker-pages.ts` (bun) | `<brain>/tickers/<code>.md`（1966 自動生成頁） | 任何資料變動後重跑 |
| `reimport-graph-pages.ts` (bun) | 重灌圖譜目錄到 PGLite | 改 wikify 規則 / 改 ticker 頁後 |
| `import-news-day.ts` (bun) | 單一 news 日目錄 → PGLite | research 入源 / 補抓某日 news 後 |
| `news-from-skill.ts` (bun) | stock-news-skill JSON → schema-v1 news-raw | 跑完 stock-news-skill 後 |
| `ingest-research.ts` (bun) | 研究報告 md/txt → research-reports/ + news-raw/ | 你寫完報告隨手跑 |
| `daily-run.ps1` (powershell) | 整條 pipeline 跑一遍 | 每交易日 |

**重要 import pattern**：python script 都透過 `from metabase_client import MetabaseClient` 用 sinopac-metabase skill 的 client（auth/token cache 在那邊處理過，不重新發明）。

---

## 9. Wiki 條目模板（gen-ticker-pages.ts 的產物 — chatbot 主要讀的東西）

每個 ticker 自動生成頁包含的段（資料缺則 graceful omit）：

```
[Frontmatter]                  type/slug/title/ticker/exchange/market/industry/full_name/listed_date/isin/website/generated: true

# 公司名 (代號)
> 一句話 (industry_position)

## 公司基本資料        cmoney 公司基本資料：全名/產業/上市日/董事長/總經理/發言人/實收資本/網址
## 主要業務             cmoney 經營項目 + 營業焦點
## 財務脈動             月營收 (fundamentals/revenue/_index.json) + 機構 EPS 估 (fundamentals/eps/_index.json)
                       — **明年機構估** bold 顯示
## 近期動能與可能原因  attribution/<latest>/<code>.json 的 top-3 candidates + narrative_hints
                       — 只 movers 才有這段
## 所屬族群             concept-groups → [[themes/...]] 連結
## 觀察點 Catalysts     規則化 (月營收公告週期 + 季度法說 + 所屬題材觸發)
## 大事年表             上市日 + 人工 (人策展頁可手寫)

---
*此頁由 gen-ticker-pages.ts 自動生成；要客製化請從 frontmatter 移除 generated: true*
```

**手策展頁 vs 自動生成頁**：
- 頁面有 `generated: true` 在 frontmatter → 視為自動生成，gen-ticker-pages 會 overwrite
- 沒有 `generated: true`（或值是 false）→ 視為人策展，skip-if-exists 保留不動
- 目前 10 檔人策展頁：2330 / 2454 / 2327 / + 一些 US ticker

**手策展頁的限制（已知短帳）**：因為整頁 skip，自動段（財務脈動 / 近期動能）也不會注入。要解這個需要 marker 系統（`<!-- AUTO:revenue -->` 之類），暫未做。

---

## 10. 歸因層（Phase E — 本專案的旗艦功能）

讓 chatbot 答「為什麼 X 今天漲」。三步：

### 10.1 E1 `movers-detect`
- Input: 當日 daily snapshot via `getDailySnapshot`
- Output: `movers/<YYYY-MM-DD>.json` = `top_gainers/top_losers/top_turnover` 各 Top 30
- 純 in-handler 排序，毫秒級

### 10.2 E2 `attribution-gather`
- Input: `movers/<date>.json` (E1 output)
- 對 `top_gainers ∪ top_turnover`（dedup, cap 50 ticker）建證據包
- **5 個 signal**，每個 0–1 啟發式分數：

| Signal | Score 公式 | 資料源 |
|---|---|---|
| `institutional_flow` | `min(max(aligned_intensity, 0) × 10, 1)` | `getInstitutionalFlow(date)` |
| `theme_rotation` | `min(peer_excess_pp / 4, 1)`，需 ≥3 peer | `concept-groups.json` + 全市場 quote |
| `news_catalyst` | `min(count / 5, 1)` | 近 7 日 news/ 目錄 disk 掃描 |
| `revenue_trigger` | 1.0 若 announce_date 在 ±2 日窗 | `fundamentals/revenue/_index.json` |
| `broker_coverage` | `min(analyst_count_next / 20, 0.6)` | `fundamentals/eps/_index.json` |

**direction alignment 設計**：對 gainer 來說只計**正向** net flow 為因；逆勢（外資投信賣但價漲）score = 0、evidence 改為「散戶推動」hint。對 loser 同理（但目前 E2 只跑 gainer + turnover）。

- Output: `attribution/<date>/<code>.json` + `attribution/<date>/_hot.md`

### 10.3 E3 wiki section
- `gen-ticker-pages.ts` 讀 `attribution/<latest>/<code>.json`，渲染「近期動能與可能原因」段
- 非 mover 的 ticker 自動跳過此段

### 10.4 **歸因品質的最大短帳**
所有 score 是工程啟發式，**未經歷史校準**。要做：
1. 抓 60 天 Top 100 大漲股
2. 人工或研究員標真正原因（ground truth）
3. 回測 weight，找最佳超參
4. 把 score 公式換成 calibrated 版

**沒做這件事之前，分數只是工程的直覺**。別把 score 當科學數值，文件裡也已標註。

---

## 11. 研究報告入源（R1 + R2 — 讓人/分析師寫的研報進圖譜）

詳見 [docs/research-reports.md](e:/SinoBrain/docs/research-reports.md)。

### 11.1 Schema 擴充（不破 schema-v1）
擴充 news schema-v1 (schema_version=1) 加可選欄位：`report_kind / analyst_firm / analyst_name / recommendation / target_price / report_date / report_url / tags`。schema-v1 的 robustness 原則「ignores unknown keys」讓這完全 backward compatible。

### 11.2 source_name 規約
- `user-research` — 你自己或分析師寫的研究
- `user-research:<firm>` — 第三方賣方報告（e.g. `user-research:morgan-stanley`）
- `internal-memo` — 公司內部備忘

### 11.3 ingest 路徑（一個 script，兩處寫）
[scripts/ingest-research.ts](e:/SinoBrain/scripts/ingest-research.ts) 讀 md/txt → 寫兩份：
1. **原始保留** → `research-reports/<date>/<slug>.md`（db_tracked，進 git）
2. **schema-v1** → `news-raw/<date>/research-<slug>.json`（db_only，pipeline 入口）

接著用戶手動跑：`news-ingest --source=user-research` → wikify → `news/<date>/research-*.md`。

### 11.4 雙 source pipeline
[src/core/data-sources/user-research-news-data.ts](e:/SinoBrain/src/core/data-sources/user-research-news-data.ts) 仿 stock-news-skill adapter，但**filter source_name 開頭 = `user-research` or `internal-memo`**。這樣 stock-news-skill 跟 user-research 共用 news-raw/ 目錄但 routing 分流。

### 11.5 關鍵 bug 教訓（重要）
article_id **不能含 CJK**。news-ingest 的 slug 生成器會把 CJK 字砍成 dashes，產生 `research-20260528-------f1587f59` 這種 slug，下游 page 寫入時被打死。所以 ingest-research.ts 的 article_id 純 ASCII = `research-<YYYYMMDD>-<fnv1a_hash>`；human-readable slug 只保留在 originals 那份。

---

## 12. 常見 workflow

### 12.1 每日 pipeline
```powershell
$BRAIN = "E:\SinoBrain-data"
$DATE = Get-Date -Format "yyyy-MM-dd"
$BUN = "C:\Users\012701\.bun\bin\bun.exe"

cd E:\SinoBrain
& $BUN run src/cli.ts jobs submit twse-daily-quotes        --follow --params "{`"brain_dir`":`"$BRAIN`",`"date`":`"$DATE`",`"source`":`"metabase`"}"
& $BUN run src/cli.ts jobs submit twse-institutional-flow  --follow --params "{`"brain_dir`":`"$BRAIN`",`"date`":`"$DATE`",`"source`":`"metabase`"}"
& $BUN run src/cli.ts jobs submit fundamentals-revenue     --follow --params "{`"brain_dir`":`"$BRAIN`",`"source`":`"metabase`"}"
& $BUN run src/cli.ts jobs submit fundamentals-eps         --follow --params "{`"brain_dir`":`"$BRAIN`",`"source`":`"metabase`"}"
& $BUN run scripts/news-from-skill.ts                       # 假設 stock-news-skill 已先跑
& $BUN run src/cli.ts jobs submit news-ingest              --follow --params "{`"brain_dir`":`"$BRAIN`",`"date`":`"$DATE`",`"source`":`"stock-news-skill`"}"
& $BUN run src/cli.ts jobs submit movers-detect            --follow --params "{`"brain_dir`":`"$BRAIN`",`"source`":`"metabase`"}"
& $BUN run src/cli.ts jobs submit attribution-gather       --follow --params "{`"brain_dir`":`"$BRAIN`",`"source`":`"metabase`"}"
& $BUN run scripts/gen-concept-themes.ts $BRAIN
& $BUN run scripts/gen-ticker-pages.ts   $BRAIN
& $BUN run scripts/reimport-graph-pages.ts $BRAIN
& $BUN run src/cli.ts extract links --source db
```

完整版見 [scripts/daily-run.ps1](e:/SinoBrain/scripts/daily-run.ps1)（尚未上 Windows 工作排程器，是 Phase D 待辦）。

### 12.2 加新 handler（拷貝 pattern）
1. 看一份既存 handler（`fundamentals-eps.ts` 是最完整的範本）
2. 抄 frame：validateParams → resolveSource → capability gate → fetch → render md + _summary + _index.json → return result
3. 在 `jobs.ts` 註冊（搜尋 `fundamentalsEPSHandler` 看位置）
4. 寫 `recipes/<name>.md`
5. `gbrain.yml` 加目錄到 db_only
6. 跑一次，sample 檢查輸出
7. 若 wiki 要露出，更 `gen-ticker-pages.ts` + reimport + extract

### 12.3 改 wikify 規則（最危險）
1. 改 [ticker-aliases.ts](e:/SinoBrain/src/core/entities/ticker-aliases.ts) 或 [news-ingest.ts](e:/SinoBrain/src/core/minions/handlers/news-ingest.ts) 的護欄
2. **砍** `C:\Users\012701\.gbrain\brain.pglite`（先關 Claude Desktop MCP）
3. 重新 `gbrain import E:\SinoBrain-data --no-embed`
4. `gbrain extract links --source db`
5. 用 `graph-query` 驗證關鍵 ticker 邊長對

不砍 pglite 就只會新加邊不會洗舊邊，會留垃圾。

### 12.4 加新 metabase 表 / 新欄位
1. 用 sinopac-metabase MCP `metabase_schema_search` 找表
2. 用 `metabase_query` sample 看欄位品質、null 比例
3. 在 [src/core/data-sources/stock-data.ts](e:/SinoBrain/src/core/data-sources/stock-data.ts) 加 interface (optional capability)
4. 在 [metabase-stock-data.ts](e:/SinoBrain/src/core/data-sources/metabase-stock-data.ts) 加實作 — **中文識別碼用雙引號**
5. 對 nullable 欄位用 `numOrNull()` 不要 `num()`（後者把 NaN/null 轉 0，會混淆）
6. 寫 handler 消費

---

## 13. 已知坑（前人/這位 AI 都踩過的）

| 坑 | 症狀 | 防法 |
|---|---|---|
| **PGLite single-writer** | 跑 import 卡住或丟 lock error | 關 Claude Desktop MCP serve 再跑 |
| **`extract` 只加邊** | 改 wikify 後舊邊還在 | 砍 pglite 重 import |
| **CJK in article_id** | slug 變 `------` 連串 dashes 被下游打死 | article_id 純 ASCII，CJK 留在 title/body |
| **bash 雙引號吃反斜線** | metabase params JSON 解析失敗 | 用 single quote + JSON 用 forward slash 路徑（`E:/SinoBrain-data` 不是 `E:\\...`） |
| **TypeScript 字串 `\S` 吃 backslash** | 寫 `'E:\SinoBrain-data'` 變成 `'E:SinoBrain-data'`，跑出去找不到 | 字串用 `'E:\\SinoBrain-data'` |
| **slug 路徑跟匯入 root 對不上** | wikilinks 找不到 target、`get` 找不到 page | 用 `relative(BRAIN_ROOT, file)` 算 slug；`importFromFile` 要傳 root-relative path |
| **trailing space tags** | `"HBM "`、`"CoWoS-L "` 等 cmoney 概念群 tag 有尾空白 | `tag.trim()` 後才 slugify |
| **schema-v1 source_name confusion** | stock-news-skill adapter 把 user-research json 也吃進去 | UserResearchNewsSource 加 prefix filter |
| **bun cwd reset** | Bash tool 連續 call 之間 cwd 不保留時，import './...' fail | 跑 bun 時用絕對路徑 OR `cd /e/SinoBrain && bun ...` |
| **fanout cap 把整篇變 plain** | 一篇文章 wikify > 8 ticker，整篇 broad_listing 沒邊 | 一篇研報講太多檔，拆篇或把 hint_tickers 寫齊 |
| **Claude Code "Co-Authored-By" trailer 被擋** | commit message 含 `Co-Authored-By: Claude` 會被權限 hook 攔下 | 不加這行；要加要在 settings.json 配 permission |
| **bare numeric 撞年份** | 2025 = 千興、2027 = 大成鋼，被新聞「2025 年」誤連 | wikify 不用 bare code，必須名字 + 代號雙確認 |

---

## 14. 一些「為什麼這樣做」（保護決策）

下面這些是踩過坑或仔細權衡後的決策。**改之前要問為什麼**，不要當作可優化點隨便動。

### 14.1 為什麼自營只取「自行買賣」不取 combined
cmoney `日自營商進出排行` 有三欄：`自營商買賣超(自行買賣)` / `自營商買賣超(避險)` / `自營商買賣超`（combined）。**避險 leg 反映 warrant/option 造市結構性反向流，不是方向性訊號**（券商賣 warrant 給散戶 → 自營 hedge 買 underlying）。所以 dealer 取「自行買賣」=真實 prop bet，總和 net 就有意義。**舊版**整個 dealer 排除是因為當時用 combined 太雜訊；改為 sub-leg 是這個 session 的升級。

### 14.2 為什麼 ticker-master.json 跟 ticker-profiles.json 分開
- master = 熱 path（wikify 對 1976 alias 都跑，要小要快）
- profiles = 寬欄位（董事長/業務/網址…），只 gen-ticker-pages 用一次，可大可慢
- 邏輯耦合但 IO 解耦

### 14.3 為什麼 attribution score 都是啟發式不是 ML 訓出來的
- 沒有 ground-truth label sample（最終要研究員人工標 60 天 Top 100 大漲股）
- 沒做這件事之前，任何「計算出來的」weight 都是工程直覺
- 比起假裝精確，明確標「啟發式 v1」更誠實

### 14.4 為什麼研究報告走 news pipeline 不另開
- news pipeline 已經有 wikify + alias map + fanout cap + disclaimer strip + graph 邊建立
- 開一條獨立 pipeline = 把這些全重做
- schema-v1 設計時就 ignore unknown keys，擴充欄位完全 backward compatible
- source_name 分流就足夠

### 14.5 為什麼 themes/ 是 db_tracked 不是 db_only
- 生成的概念群頁是「資料快照」但**內容會被人手 enrich**（敘事、催化劑、investment thesis），需要進 git
- 但 .md 內容是 gen-concept-themes.ts 寫的成分清單 → 寫的時候用 `skip-if-exists`，不蓋人手 enrich

### 14.6 為什麼 fundamentals 不切成 quarterly vs monthly
- 兩者 cadence 完全不同（月營收 ~10號公告、季財報 ~45 天）
- 但分析消費端基本同 pattern：snapshot per ticker per period
- 同一個 `fundamentals/` 容器下分 `revenue/<YYYY-MM>/` 跟 `quarterly/<YYYY-Q>/` 子目錄即可

### 14.7 為什麼 cmoney 表的 SQL 用 string concat 不是 prepared statement
- ClickHouse JDBC over HTTP，本來就走 server-side string SQL
- 中文 identifier + 受信 input（date / ticker 都 validateParams 過）
- 加 prepared 反而要寫一層抽象，沒收益

---

## 15. 短帳（從 Sprint 1 結束時看）

排優先序：

### 🔴 機構 chatbot 上線前必補
- 季財報 handler（`getQuarterlyFundamentals`）+ wiki「季財報快照」段
- `gbrain serve --http`（內建有，需試）
- OpenAI key 接上開 hybrid search (semantic search)
- daily-run 上 Windows 工作排程器

### 🟡 答覆深度提升
- 法說會逐字稿 handler（cmoney 可能有 conference call summary，待確認表名）
- 重大訊息 — 路線 A（`日個股事件` flag handler）
- 手策展頁 marker 注入系統（讓 2330/2454/2327 也吃自動段）
- 新聞歷史回補（近 90 天 cmoney `證券市場新聞`）

### 🟢 籌碼面再厚
- 融資融券 handler
- 券商分點 handler
- TDCC 大戶持股比例
- 盤中即時行情（Shioaji / 公司即時 feed — 待 source 確認）

### 🔵 歸因品質升級
- 歷史校準：60 天 Top 100 ground truth → weight 回測
- 大盤 / 跨市場聯動 candidate（TAIEX up + NVDA up → ABF 漲）
- 投信新進 / 退出（top of book churn）

### ⚪ 介面 / 對外
- OAuth + per-customer source 隔離
- HTTP API + OpenAPI spec
- 客戶反饋迴路（chatbot 答錯怎麼回到 fix 資料）

詳細 sprint 規劃見 [Sprint 1 結束時的對話紀錄](e:/SinoBrain/docs/PROJECT_OVERVIEW.md)。

---

## 16. Validation playbook — 改完怎麼確認沒壞

| 動到 | 跑這個驗證 |
|---|---|
| handler 邏輯 | `gbrain jobs submit <name> --follow --params ...` 看 result + sample 看 disk 輸出 |
| wikify 規則 | 砍 pglite → reimport → extract → `graph-query tickers/<熱門> --direction in` 看入邊 |
| gen-ticker-pages | 跑 generator → 抽 3 樣本看 md（一檔 mover、一檔小型、一檔手策展應跳過） |
| metabase adapter | 直接 `metabase_query` SQL 比對；單檔抽 3 樣本看 NaN/null 處理 |
| 圖譜 | `gbrain graph-query <slug> --direction both --depth 2` |
| 新加資料源 | `getX('TWSE', date)` 跑成功 + return shape 正確、null 處理對 |
| ingest-research | `--dry-run` 看 schema-v1 + frontmatter 解析正確 |

**rule of thumb**：handler 改完一定要實際跑一次、看 disk 輸出，不能只靠 type check。

---

## 17. 跟 chatbot 的介面契約

chatbot 從這 5 個接口拿資料：

1. **個股 wiki 頁** `tickers/<code>.md` — 「2330 是做什麼的」直接讀
2. **族群成分頁** `themes/<slug>.md` — 「機器人有哪些」直接讀
3. **每日 snapshot 檔** `prices/twse/<date>/<code>.md`、`institutional-flow/twse/<date>/<code>.md`、`fundamentals/{revenue,eps}/<YYYY-MM>/<code>.md` — chatbot 要組合查時讀
4. **歸因 evidence** `attribution/<date>/<code>.json` — 「為什麼 X 今天漲」核心
5. **圖譜查詢** `gbrain graph-query` 或未來 HTTP endpoint — chatbot 要橫向關聯時用
6. **hybrid search**（待 Phase C 開）— 客戶問模糊詞時走語意 + 關鍵字 + 圖譜

chatbot 怎麼把這些變成人話 = 不是你的事。但 chatbot 那邊吐槽資料不對 = 是你的事。

---

## 18. 你接手第一週該做的 3 件事

1. **讀過這份**（眼下）+ [PROJECT_OVERVIEW.md](e:/SinoBrain/docs/PROJECT_OVERVIEW.md) + 抽 3 個 handler 讀完（建議 `fundamentals-eps.ts`、`attribution-gather.ts`、`news-ingest.ts`）
2. **跑一次 daily pipeline**，sample 看每個 stage 的 output，建立 disk schema 的肌肉記憶
3. **挑一個 🔴 短帳** 動手做（建議季財報 handler — 跟月營收/EPS 同 pattern，最不會撞牆）

---

## 19. 維持這份文件

當你做了下面這些事，回來更新這份：

| 動作 | 要更新的章節 |
|---|---|
| 加 handler | §7 表格 + §15 短帳 |
| 改 wikify 護欄 | §4.2 |
| 加 / 改 metabase 表 | §3 |
| 踩到新坑 | §13 |
| 做了非顯然的決策 | §14 |
| 推進 roadmap | §15 移到「已完成」標記 |

memory 系統 (`~/.claude/projects/e--/memory/`) 比這份還 fine-grained，記錄 session-level 觀察。這份是「穩定基礎事實」，memory 是「實時筆記」。兩者並存。

---

**最後一句心法**：這顆腦的價值 = **資料的圖譜性 × 新鮮度 × 精度**。任何決策回到這三軸權衡：哪個受益、哪個受損、值不值得。
