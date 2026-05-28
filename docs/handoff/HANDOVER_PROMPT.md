# 交接 prompt — 給下一位開發者的 AI

把這份檔給下一位接手 SinoBrain 的同事。**第 2 節「給 AI 的 prompt」直接複製貼給他的 AI**，後面幾節（驗收、規約）你自己看，要的時候回來查。

---

## 1. 交接前你（前手）要先做的事

不交給 AI、你自己一次性處理：

1. **推上游** — 確認所有改動都在 GitHub 上：
   ```
   cd E:\SinoBrain && git push origin master
   ```
2. **打包 SinoBrain-data**（不在 git）：
   ```
   tar czf sinobrain-data-seed.tgz -C E:\SinoBrain-data \
     tickers themes sectors playbooks client-prep research-reports gbrain.yml
   ```
   給同事 → 他用 daily-run 自己重建 db_only 那一坨。
3. **同事端需要**：bun 1.3+、自己的 metabase 帳號、`~/.claude/skills/sinopac-metabase/` skill（拷給他或叫他自己裝）。

---

## 2. 給 AI 的 prompt（複製貼上）

````text
我接手一個叫 SinoBrain 的專案 — 永豐金證券股市情報大腦，GBrain v0.37.1.0 的 fork。
我把它從前一位開發者那邊接過來，要你跟我一起繼續做。

請按順序執行下面 6 步，每步做完跟我回報結果再進下一步：

【1. 取程式碼】
git clone https://github.com/how0531/Sino-StockBrain.git E:\SinoBrain
cd E:\SinoBrain && bun install

【2. 讀文件（必讀，順序重要）】
- docs/PROJECT_OVERVIEW.md（人類版交接書 — 知道專案在做什麼）
- docs/handoff/2026-05-28-agent-handoff.md（AI 版 19 章交接 — 知道實際長相 + 不可改的決策）
- CHANGELOG-SINOBRAIN.md（理解 Sprint 1 與之前的時間線）
讀完跟我回報：你抓到的最重要 3 件事是什麼？哪一段你覺得最容易踩坑？

【3. 環境設定】
- 設 .env：METABASE_URL=http://128.110.25.99:3001、METABASE_USER=<你的>、METABASE_PASS=<你的>、
  OPENAI_API_KEY（選填，未來 hybrid search 用）、ANTHROPIC_API_KEY（選填，compliance LLM 用）
- 從我給你的傳輸介質（檔名 sinobrain-data-seed.tgz）解出 SinoBrain-data 到 E:\SinoBrain-data
- 跑 bun run src/cli.ts init --pglite 建空 PGLite 腦

【4. 驗證設定對】依序跑：
  bun run scripts/gen-stock-master.py              # metabase 通的話會更新 master
  bun run scripts/gen-stock-profiles.py            # 同上，更新 profiles
  bun run scripts/gen-concept-themes.ts            # 重建 themes/
  bun run scripts/gen-ticker-pages.ts              # 重建 1966 檔個股維基頁
  bun run scripts/reimport-graph-pages.ts          # 灌進 PGLite（不要用 gbrain import <root>，會吃 43k db_only 檔）
  bun run src/cli.ts extract links --source db    # 建邊
  bun run src/cli.ts graph-query tickers/2330 --direction in --depth 1
       → 應該看到 themes/cowos、themes/ai-infrastructure 等邊

【5. 跑一次 daily pipeline】
按 docs/handoff/2026-05-28-agent-handoff.md §12.1 的 PowerShell 範例跑一遍，
驗證 movers/<date>.md、attribution/<date>/_hot.md、fundamentals/{revenue,eps}/ 都有東西。

【6. 對齊下一步】
讀 docs/handoff/2026-05-28-agent-handoff.md §15「短帳」清單，
提出你建議的第一個 sprint（最多 4 個 story、1.5 週），等我確認再動手。

—— 重要 scope boundary（不要踩過）——
你只管資料層：抓取 / 標準化 / 圖譜 / 內容組織 / 監控
你不管：chatbot UX、LLM prompt 設計、合規 rubric 法務簽核、客戶認證、計費

如果有狀況需要決策（規格不明、踩到上游 GBrain 程式碼、要動人策展頁），停下來問我，不要自己決定。
````

---

## 3. 驗收 — AI 開始改 code 之前，先問這 6 題

確認他真讀懂了 docs/handoff/2026-05-28-agent-handoff.md，不是只 skim。

| 題目 | 期待回答 |
|---|---|
| 「自營為什麼只取自行買賣？」 | 避險 leg 是 warrant/option market-making 結構性反向流，自行買賣才是 prop bet 訊號 |
| 「article_id 為什麼不能含中文？」 | news-ingest slug 生成器砍 CJK 變 `-------` dashes，下游頁面寫入失敗 |
| 「我要改 wikify 規則 要做什麼？」 | 砍 `~/.gbrain/brain.pglite` → reimport → extract（extract 只加邊不刪邊） |
| 「fundamentals-revenue handler 在哪？」 | `src/core/minions/handlers/fundamentals-revenue.ts`（要能秒答路徑） |
| 「為什麼 themes 是 db_tracked 不是 db_only？」 | 雖然 generator 寫，但 .md 內容會被人手 enrich 敘事 / 催化劑，要進 git；generator 用 skip-if-exists |
| 「不要刪 SAFE_SHORT_NAMES allow-list 對嗎？為什麼？」 | 對。2 字 CJK 多數是 common-word substring（統一/大同/中華）；非清單上的 2 字名只走 hint_tickers 不 wikify |

答得出 → 對齊了，可放手做。
答不出 → 沒讀懂，叫他**回去重讀那段**再來。

---

## 4. 持續追蹤規約（跟 AI 約好）

每完成一個 sprint，AI 必須做：

1. 更新 [CHANGELOG-SINOBRAIN.md](e:/SinoBrain/CHANGELOG-SINOBRAIN.md) — 加新 `## [Sprint N] — YYYY-MM-DD` 段在頂部
2. 加新檔 `docs/handoff/YYYY-MM-DD-agent-handoff.md` — 沿用 [2026-05-28-agent-handoff.md](e:/SinoBrain/docs/handoff/2026-05-28-agent-handoff.md) 19 章結構
3. 若改了 wikify / 加 metabase 表 / 踩到新坑 → 更新該檔 §4 / §3 / §13 對應章節
4. 若做了非顯然決策 → 進 §14「為什麼這樣做」

**這些不更新的話下一輪交接會崩**。跟他先講好。

---

## 5. 如果同事用的不是 Claude

第 2 節 prompt 直接適用，但驗收（§3）答覆會比較鬆 — 不同 AI 對 codebase 理解程度差異大。額外要求：

> 「**讀文件時，每章節結束時做一段 30 字摘要 paste 給我看**」

你才能即時看出他讀懂多少。
