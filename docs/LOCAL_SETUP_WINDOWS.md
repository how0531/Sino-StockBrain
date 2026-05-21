# 本地設定指南（Windows）

把 Sino-StockBrain 跑在本地 Windows 機器的完整步驟。Mac / Linux 使用者
看 [`INSTALL.md`](./INSTALL.md)。

## ⚠️ 先決定放在哪 — 不要放 OneDrive / 雲端同步資料夾

OneDrive、Google Drive、Dropbox 這類即時同步資料夾**會破壞** git repo 與
大腦資料庫：

- 同步鎖檔 → git commit / DB 寫入失敗
- 同步半寫入的檔 → PGLite DB 或 JSON 損毀
- `.git/` 數萬小檔灌爆同步配額
- 每日數萬筆 `news/` `prices/` 灌爆空間

**建議路徑**（非同步）：

```
C:\dev\SinoBrain
```

如果一定要放在同步資料夾底下，先排除這些子目錄的同步：
`.git`、`.gbrain`（在使用者家目錄，通常不在同步資料夾）、`news`、
`news-raw`、`prices`、`institutional-flow`。OneDrive 排除方式：右鍵資料夾
→「永遠保留在此裝置上」反而會更糟，正確做法是用
「設定 → 帳戶 → 選擇資料夾」取消勾選，或把 repo 移出同步範圍。

## 1. 安裝 Bun

PowerShell（系統管理員）：

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

關掉再開一個新的 PowerShell，確認：

```powershell
bun --version
```

## 2. Clone repo

```powershell
mkdir C:\dev
cd C:\dev
git clone https://github.com/how0531/Sino-StockBrain.git SinoBrain
cd SinoBrain
```

> 若預設分支不是你要的版本，切到對的分支：
> `git checkout master`（或目前開發分支名）

## 3. 安裝相依套件

```powershell
bun install
```

## 4. 設定 API keys（不會進 git）

複製範本：

```powershell
copy .env.testing.example .env
notepad .env
```

填入：

```
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

`.env` 已被 `.gitignore` 排除，不會外洩。

## 5. 初始化大腦

```powershell
bun run src/cli.ts init --pglite
bun run src/cli.ts doctor
```

`init --pglite` 會在 `C:\Users\<你>\.gbrain\` 建立本地大腦（**不在** repo 內，
**不在** OneDrive 內 — 安全）。

## 6. 第一次同步（把 ticker/sector/theme 頁吃進大腦）

```powershell
bun run src/cli.ts sync
```

驗證 graph 自動串連：

```powershell
bun run src/cli.ts graph-query tickers/2330 --depth 2
```

## 7. 跑每日 pipeline

你的機器網路開放（不像 CI 容器），可以直接抓 live 新聞：

```powershell
$BRAIN = (Get-Location).Path
$DATE = Get-Date -Format "yyyy-MM-dd"

# 抓 live RSS（路徑依實際來源調整）
bun run src/cli.ts jobs submit rss-news-fetch --params "{\"brain_dir\":\"$BRAIN\",\"source_name\":\"cnyes\",\"rss_url\":\"https://news.cnyes.com/rss/cat/tw_stock\"}"

# 標準化 + wikify
bun run src/cli.ts jobs submit news-ingest --params "{\"brain_dir\":\"$BRAIN\",\"date\":\"$DATE\",\"source\":\"stock-news-skill\"}"

# heat 合成
bun run src/cli.ts jobs submit market-heat --params "{\"brain_dir\":\"$BRAIN\",\"date\":\"$DATE\"}"

# 吃進大腦
bun run src/cli.ts sync
```

> PowerShell 的 JSON 跳脫很煩。建議把這幾行存成 `daily-run.ps1` 一鍵跑，
> 或用 Git Bash（`bash scripts/daily-run.sh`，如果有提供）。

## 8. 提交知識（不含每日大量資料）

```powershell
git add tickers/ sectors/ themes/ playbooks/digests/ client-prep/
git commit -m "digest $DATE"
git push origin master
```

`news/`、`news-raw/`、`prices/` 等已被 `.gitignore` 排除，不會進 commit。

## 什麼進 git、什麼留本地

| 進 GitHub（版本控制） | 只留本地（gitignore） |
|---|---|
| `src/` 程式碼 | `news/` wikify 後新聞 |
| `skills/` `recipes/` | `news-raw/` 原始 JSON |
| `tickers/` `sectors/` `themes/` | `prices/` 每日 OHLCV |
| `playbooks/digests/` 分析師日報 | `institutional-flow/` 三大法人 |
| `client-prep/` 合規過內容 | `playbooks/heat/` 機器生成 heat |
| `.env`（**範本** `.env.testing.example`） | `.env`（真實 key，已 ignore） |

## 大腦資料庫在哪？

| 引擎 | 位置 | 跨機器 |
|---|---|---|
| PGLite（預設） | `C:\Users\<你>\.gbrain\` | ❌ 單機 |
| Supabase | 雲端 Postgres | ✅ 多機器共享 |

單機 PoC 用 PGLite。團隊多台機器看同一個大腦 → `gbrain migrate --to supabase`。

## 常見問題

**Q: bun 指令找不到？**
重開 PowerShell。或手動把 `C:\Users\<你>\.bun\bin` 加進 PATH。

**Q: 中文路徑 / 路徑有空格出錯？**
這是建議放 `C:\dev\SinoBrain` 的原因之一。路徑越單純越好。

**Q: `gbrain` 指令而非 `bun run src/cli.ts`？**
全域安裝：`bun install -g github:how0531/Sino-StockBrain`，之後可直接打
`gbrain doctor`。但開發期建議用 `bun run src/cli.ts` 確保跑的是本地 code。

**Q: 多人協作會衝突嗎？**
每日大量資料不進 git，所以衝突點只在 ticker 頁 / digest。用 Supabase 共享
大腦 DB，git 只同步知識，衝突面很小。
