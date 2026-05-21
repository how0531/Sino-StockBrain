# Sino-StockBrain — 專案總覽

> 這份文件是專案的「交接書」。從遠端開發環境轉到本地 Claude Desktop 後,
> 你(或你的本地 agent)讀這份就能接上進度。

---

## 一、專案目的

把 [GBrain](https://github.com/garrytan/gbrain)(YC CEO 開發的個人知識大腦)
客製成 **股市情報大腦**:每天自動匯集市面上最熱的個股、產業、財經資訊,
讓公司能透過這個大腦產生對客戶交易有幫助的訊息。

核心價值來自 GBrain 兩個獨特能力,套用到股票領域:

1. **自織知識圖譜** — 新聞裡提到「國巨」,自動連到 `[[tickers/2327]]`,
   再連到被動元件產業、同業華新科、它的法說會…整張關係網自己長出來,
   零 LLM 成本。
2. **混合檢索 + 夜間迭代** — 向量 + 關鍵字 + 關係圖,加上 cron 驅動的
   每日彙整。

服務對象(分階段):公司內部分析師 → 機構客戶 → 散戶。

---

## 二、工作架構

### 完整資料流

```
資料源層
  ├── rss-news-fetch       真實 RSS 抓取器(HTTP + XML 解析)
  ├── stock-news-skill     你本地的新聞 skill(寫 schema-v1 JSON)
  ├── twse-daily-quotes    每日 OHLCV(mock / TWSE OpenAPI / 未來客戶 DB)
  └── twse-institutional-flow  三大法人(mock / 未來客戶 DB)
        │
        ▼  寫進 <brain_dir>/news-raw、prices、institutional-flow
標準化層
  └── news-ingest          讀 raw JSON → wikify(國巨→[[tickers/2327]])→ news/*.md
        │
        ▼
建圖層
  └── gbrain extract       掃所有頁面的 [[tickers/xxx]] → 建 typed edges
        │                  ⚠️ 關鍵:import 只匯入,extract 才建邊
        ▼
訊號合成層
  └── market-heat          量價 + 法人 + 新聞密度 → heat_score → playbooks/heat/
        │
        ▼
產出層
  └── daily-market-digest  分析師日報(skill,引用真實新聞)→ playbooks/digests/
        │
        ▼
合規層
  └── compliance-filter    Layer1 regex + Layer2 LLM judge
        │                  抓「建議買進/賣出」等違規
        ├── pass   → client-prep/   (可對外推送)
        └── fail   → playbooks/violations/  (分析師修正)
```

### 兩個正交軸(GBrain 核心觀念)

- **Brain** = 哪個資料庫(PGLite 單機 / Supabase 共享)
- **Source** = 同一個 DB 內哪個內容區(default / 各客戶隔離)

### 關鍵設計:資料源適配層

所有資料源走統一介面,未來換真實 DB 是「加一個檔 + factory 一個 case」,
handler / 內容 / recipe 全不動:

```
src/core/data-sources/
  stock-data.ts          StockDataSource 介面 + factory
  mock-stock-data.ts     模擬量價 + 法人(deterministic)
  twse-openapi-stock-data.ts  真實 TWSE OpenAPI
  news-data.ts           NewsSource 介面 + factory
  mock-news-data.ts      模擬新聞
  stock-news-skill-news-data.ts  讀你 skill 的 JSON
  rss-parse.ts           RSS 2.0 解析(純函式)
  (未來) customer-db-stock-data.ts  ← 你的內部 DB 接這
```

### 信任邊界

- 本地 CLI 呼叫 = 信任(`remote: false`)
- MCP / OAuth 呼叫 = 不信任(`remote: true`)
- `compliance-filter` 是對外推送前的最後關卡
- raw news 可含原作者立場/推測(那是 source 的聲音),不會直接到客戶

---

## 三、完整本地工作流(已驗證)

### 一次性設定

```powershell
# 程式碼(工具)
cd E:\ ; git clone https://github.com/how0531/Sino-StockBrain.git SinoBrain
cd E:\SinoBrain ; bun install
copy .env.testing.example .env  # 填 OPENAI_API_KEY / ANTHROPIC_API_KEY(可選)

# 大腦內容(跟程式碼分開!)
mkdir E:\SinoBrain-data
Copy-Item E:\SinoBrain\tickers   -Destination E:\SinoBrain-data\tickers -Recurse
Copy-Item E:\SinoBrain\sectors   -Destination E:\SinoBrain-data\sectors -Recurse
Copy-Item E:\SinoBrain\themes    -Destination E:\SinoBrain-data\themes -Recurse
Copy-Item E:\SinoBrain\gbrain.yml -Destination E:\SinoBrain-data\gbrain.yml
del E:\SinoBrain-data\tickers\_template.md

# 初始化大腦
bun run src/cli.ts init --pglite
```

### 灌資料 + 建圖（關鍵:import 後一定要 extract!）

```powershell
cd E:\SinoBrain
bun run src/cli.ts import E:\SinoBrain-data --no-embed
bun run src/cli.ts extract links --source db        # ← 建關係圖的邊
bun run src/cli.ts graph-query tickers/2330 --depth 2  # 驗證
```

### 每日 pipeline

```powershell
$BRAIN="E:\SinoBrain-data"; $DATE=Get-Date -Format "yyyy-MM-dd"
# 抓新聞 → 標準化 → heat → 建圖
bun run src/cli.ts jobs submit rss-news-fetch --follow --params "{...}"
bun run src/cli.ts jobs submit news-ingest --follow --params "{...}"
bun run src/cli.ts jobs submit market-heat --follow --params "{...}"
bun run src/cli.ts extract links --source db
```

(細節見 `docs/LOCAL_SETUP_WINDOWS.md`、`scripts/daily-run.ps1`)

### 用 Claude Desktop 查詢(自己用的爽路線)

設定檔 `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sino-stockbrain": {
      "command": "C:\\Users\\<你>\\.bun\\bin\\bun.exe",
      "args": ["run", "E:\\SinoBrain\\src\\cli.ts", "serve"]
    }
  }
}
```

重啟 Claude Desktop → 直接問「台積電供應鏈有哪些」「被動元件最近怎樣」,
Claude 自動查你的大腦回答。

---

## 四、目前完成度

| 模組 | 狀態 |
|---|---|
| 儲存分層(db_tracked vs db_only) | ✅ |
| 10+6 檔 ticker 範本(台股權值 + 美股 + 被動元件) | ✅ |
| sector / theme 頁 + 自織圖譜 | ✅(已驗證建邊) |
| StockDataSource 適配層 + mock | ✅ |
| 三大法人 handler | ✅ |
| 新聞 wikify(alias map) | ✅ |
| 真實 RSS 抓取器 + parser | ✅ |
| stock-news-skill JSON adapter | ✅ |
| heat-score 合成 + handler | ✅ |
| daily-market-digest skill | ✅ |
| compliance filter(regex + LLM) | ✅ |
| 單元測試 | ✅ 211 個全綠 |
| Windows 本地設定 + daily-run 腳本 | ✅ |

---

## 五、未來規劃

### 近期(讓系統更可用)

- [ ] **接你本地的 stock-news-skill** — 寫 schema-v1 JSON 到 news-raw/,
      或直接用內建的 rss-news-fetch 抓 live(你網路開放)
- [ ] **設 OpenAI key** — 開啟語意搜尋(現在只有關鍵字 + 圖譜)
- [ ] **補滿 watchlist** — 把你真正關注的個股加進 tickers/
- [ ] **Calibration loop** — 事後追蹤 heat top-N 個股次日表現,
      讓系統自動學 heat_score 權重(GBrain 最強護城河)

### 中期(變團隊工具)

- [ ] **Supabase** — `gbrain migrate --to supabase`,多分析師共享同一大腦
- [ ] **Windows 工作排程器** — 每交易日 15:30 自動跑 daily-run
- [ ] **美股對應線** — SEC EDGAR + 13F 機構持倉 + 美股新聞
- [ ] **大腦內容版控** — E:\SinoBrain-data 自己開一個 git repo

### 對外(服務客戶)

- [ ] **機構 MCP endpoint** — `gbrain serve --http` + OAuth 分客戶 source 隔離
- [ ] **散戶 LINE bot** — 對 client-prep 內容做合規推播
- [ ] **RELAXED_RUBRIC** — 機構客戶用較寬鬆的合規規則

---

## 六、踩過的坑(留給未來的你)

1. **import ≠ 建圖**:`import` 只匯入頁面,`gbrain extract links --source db`
   才建關係圖的邊。daily-run 的 `sync` 會自動 extract,但手動 import 要記得補。
2. **slug 一律小寫**:gbrain 自動把 slug 轉小寫。美股 ticker 用小寫
   (`tickers/nvda` 不是 `tickers/NVDA`),不然 import 會 skip。
3. **brain 內容要跟程式碼分開**:不然 import 整個 repo 會吃進 CLAUDE.md、
   CHANGELOG.md 那些 1MB 程式文件。
4. **不要放 OneDrive**:同步會鎖檔 + 弄壞 DB。用本機硬碟(E:\)。
5. **沒 key 也能跑核心**:抓新聞 / wikify / 建圖 / heat 全是純計算,
   語意搜尋 + LLM 合規才需要 key。

---

## 七、關鍵檔案地圖

| 路徑 | 作用 |
|---|---|
| `src/core/data-sources/` | 資料源適配層(換真實 DB 改這) |
| `src/core/minions/handlers/` | 各 pipeline handler |
| `src/core/heat-score/compute.ts` | heat_score 純函式(調權重改這) |
| `src/core/compliance/` | 合規 filter(改規則改 rubric.ts) |
| `src/core/entities/ticker-aliases.ts` | 名稱→ticker 對照 + wikify(加新公司改這) |
| `tickers/ sectors/ themes/` | 大腦內容(起始種子,複製到 SinoBrain-data) |
| `recipes/*.md` | 每個 pipeline 的使用說明 |
| `skills/stock-news-skill/SKILL.md` | 你本地 skill 要遵守的 JSON 合約 |
| `docs/LOCAL_SETUP_WINDOWS.md` | Windows 設定完整指南 |
| `scripts/daily-run.ps1` | 每日一鍵跑 |
