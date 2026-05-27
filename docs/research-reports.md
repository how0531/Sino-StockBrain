# 研究報告 → 新聞源 (User-Provided Research Reports)

## 目的

讓你（或公司其他分析師）直接把**研究報告 / 投資觀察筆記 / 第三方賣方報告**
餵進 SinoBrain，跟新聞流走同一條 pipeline 進圖譜：

```
你的 MD/PDF 報告
  → scripts/ingest-research.ts (R2)
  → <brain_dir>/news-raw/<date>/research-*.json   (schema-v1)
  → news-ingest handler          (wikify, 標 hint_tickers)
  → <brain_dir>/news/<date>/*.md (圖譜節點)
  → extract links                 (個股 ↔ 報告 邊建立)
```

chatbot 之後問 *「2330 最近有什麼研究報告？」*，從圖譜入邊就能撈到。

## 為什麼跟新聞共用 pipeline，而不是另開一條？

| 走新聞 pipeline | 開獨立 pipeline |
|---|---|
| ✅ 圖譜邊（個股 ↔ 文章）已建好 | ❌ 要重寫 |
| ✅ wikify、alias map、fanout cap、disclaimer strip 全套規則複用 | ❌ 要再寫一套 |
| ✅ chatbot 用同一條查詢路徑（個股入邊 → 文章列表） | ❌ 要 chatbot 分流 |
| ⚠️ schema 要區分「報告」vs「新聞」（用 `source_name` + `report_kind`） | ✅ 完全乾淨 |

**結論：共用 pipeline，加 schema 欄位區分。**

## Schema 擴充（在 schema-v1 上加可選欄位）

schema-v1 設計時就「忽略 unknown keys」，所以下面新欄位**對既有 news-ingest
完全 backward compatible**。

```json
{
  "schema_version": 1,

  // 既有必填
  "article_id": "research-2026-05-28-memorycycle-abc123",
  "source_name": "user-research",     // 區分新聞源用，必須以 "user-research" 開頭
  "published_at": "2026-05-28T14:30:00+08:00",
  "title": "Memory cycle bottoming, prefer 2344/2408",
  "body": "<full markdown body of the report>",

  // 既有選填
  "hint_tickers": ["2344", "2408"],   // 強烈建議填，讓 wikify 對長尾代碼也建邊
  "url": "https://...",
  "fetched_at": "2026-05-28T14:30:00+08:00",

  // === 研究報告擴充欄位（都選填）===
  "report_kind": "user-research",     // "user-research" | "broker" | "internal-memo"
  "analyst_firm": "Sinopac Research", // 報告來源機構（給 chatbot citation 用）
  "analyst_name": "郭文浩",            // 分析師姓名
  "recommendation": "Buy",            // "Buy" | "Hold" | "Sell" | "Neutral"
  "target_price": 180.0,              // TWD，個股目標價
  "report_date": "2026-05-28",        // 報告本身的日期（有時 != published_at）
  "report_url": "...",                // 原始 PDF 連結（若有）
  "tags": ["memory", "AI", "macro"]   // 自由 tag
}
```

## `source_name` 規約

| `source_name` | 含義 |
|---|---|
| `user-research` | 你或公司分析師寫的純研究 / 觀察筆記 |
| `user-research:<firm>` | 第三方賣方報告（如 `user-research:morgan-stanley`），chatbot 顯示時可引用機構名 |
| `internal-memo` | 公司內部備忘錄（不對外） |
| 其他既有：`cnyes`/`udn`/`anue`/`ctee`/`yahoo`/`moneydj`/`metabase` | 新聞源（既有） |

chatbot 看到 `source_name` 以 `user-research` 開頭時：
- 顯示為「研究觀點」而非「新聞報導」
- 可信度權重不同（自家研究 > 賣方 > 散戶觀察）
- 引用格式：「根據 [analyst_firm] [report_date] 報告 …」

## 檔案存放位置

```
<brain_dir>/
  research-reports/           # ★原始檔，db_tracked (你寫的要進 git)
    <YYYY-MM-DD>/
      <slug>.md               # 你原始的 markdown 報告
      <slug>.pdf              # 原始 PDF（若有）
  news-raw/<YYYY-MM-DD>/      # 轉成 schema-v1 後的 JSON
    research-<slug>.json
  news/<YYYY-MM-DD>/          # news-ingest 處理後的 wikified MD（圖譜節點）
    <slug>.md
```

`research-reports/` 是 **db_tracked**（人寫的、要 git）；`news-raw/` 和
`news/` 是既有 db_only（regenerable）。

## hint_tickers 為什麼必填等級

`hint_tickers` 是「報告討論哪些個股」的明確標記，news-ingest 會把它們**直接**
建邊到圖譜，**不需要 wikify 在 body 裡撞到名字**。這對研究報告特別重要：
- 報告可能用代碼不用名字（「2330 vs 2344」）
- 報告可能用簡稱或英文（"TSM" / "MTK"）
- 報告可能談宏觀沒指名個股，但你想標哪幾檔為相關

填了 hint_tickers 就一定建邊，沒填就靠 wikify 撞名碰運氣。

## 輸入格式

R2 ingest 腳本（下個 story）會支援：
- **Markdown (.md)** — 最直接，body 取整個檔案內容
- **Plain text (.txt)** — body 取整個檔案內容
- **PDF (.pdf)** — 透過 gbrain 的 PDF 處理路徑抽出 text body（若 gbrain 內建已支援）

報告元資料的給法（兩條路）：
1. **檔案 frontmatter**：MD 檔自帶 YAML frontmatter（title / analyst_firm /
   hint_tickers / recommendation / target_price ...），腳本直接讀
2. **CLI flags**：`--title=... --tickers=2330,2454 --firm="Sinopac"
   --rec=Buy --tp=180` — 給沒 frontmatter 的純文字 / PDF 用

## chatbot 的查詢路徑（為什麼這樣設計）

**Q1 「2330 最近有什麼研究？」**
- chatbot 走圖譜入邊：`tickers/2330 ← mentions ← news/<date>/*.md`
- 過濾 `source_name` 開頭為 `user-research`
- 排序 published_at 降冪

**Q2 「最近什麼題材有研究覆蓋？」**
- 走圖譜：`themes/<X> ← mentions ← research articles`（透過共現個股）
- 或直接掃 news-raw 找 tags

**Q3 「你對 2330 的目標價多少？」**
- 取最新一篇 `source_name` 含 `user-research`、`hint_tickers` 含 2330、
  `target_price` 非空的紀錄

## 寫研究報告的最佳實作（給未來自己看）

要讓研究報告對 chatbot 最有用：

1. **Title 寫具體**：「Memory cycle bottoming, prefer 2344/2408」比
   「半導體觀察」好 10 倍
2. **第一段就點名 ticker**：body 第一段提到的代碼 / 公司名最容易被
   wikify 抓到、權重最高
3. **填 hint_tickers**：明確標的至少進清單
4. **填 recommendation + target_price 如果有意見**：chatbot 才答得出
   「你怎麼看 2330」
5. **report_date 不要懶**：賣方報告通常有自己的 cover date，不是上傳時間
6. **多檔報告分開寫**：一篇報告討論 10 檔股票，wikify 會 fanout > 8
   觸發 cap、整篇變 plain text 沒邊。要嘛拆開、要嘛確保 hint_tickers 填了

## 不在這個 R 系列做的（之後可能）

- LLM 自動摘要報告成短訊息（chatbot 層）
- 報告品質評估 / 過去命中率追蹤（attribution 層延伸）
- 自動和新聞 fact-check 比對（風控層）
- 共享給其他分析師的協作介面（Supabase migration 後）
