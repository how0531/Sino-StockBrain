# Recipe: `attribution-gather`

**Phase E step 2** — for the day's movers (E1 output), gather 5 evidence
streams and score each as a candidate cause. Output is what the chatbot
reads to answer *「為什麼 X 今天漲？」*.

## Output

```
<brain_dir>/attribution/<YYYY-MM-DD>/<code>.json   per-mover evidence pack (chatbot)
<brain_dir>/attribution/<YYYY-MM-DD>/_hot.md       human-readable summary
```

JSON shape (per mover):

```json
{
  "ticker": "5321", "name": "美而快", "date": "2026-05-27",
  "price_change_pct": 10.0, "turnover": 14400000, "market_avg_pct": -0.49,
  "candidates": [
    { "type": "theme_rotation", "score": 1.0,
      "evidence": "「電商」族群當日 7 檔同儕均漲 3.98% (大盤均 -0.49%, 超漲 4.47pp)",
      "data_ref": "concept-groups:電商",
      "details": { "theme": "電商", "peer_count": 7, "peer_avg_pct": 3.98, "market_avg_pct": -0.49, "excess_pp": 4.47 } },
    { "type": "institutional_flow", "score": 0.0,
      "evidence": "逆勢：外資+投信 net -2,000 股 (強度 -1.0%) 與股價方向相反，非因法人推動",
      ... }
  ],
  "narrative_hints": ["法人逆勢 (散戶推動)", "族群輪動 — 電商"]
}
```

## Evidence types (5)

| type | score 0–1 | data source | trigger heuristic |
|---|---|---|---|
| `institutional_flow` | `min(max(aligned_intensity, 0) × 10, 1)` | `dataSource.getInstitutionalFlow(date)` | 外資+投信 net 跟股價方向**一致**才算因 (gainer 要正 net) |
| `theme_rotation` | `min(excess_pp / 4, 1)` | `concept-groups.json` + 當日全市場 quote | 同題材 ≥3 檔同儕均漲超大盤 ≥1pp |
| `news_catalyst` | `min(count / 5, 1)` | `news/<recent-7d>/*.md` 圖譜入邊 | 近 7 日 ≥1 則新聞 / 研報 |
| `revenue_trigger` | 1.0 (有就滿分) | `fundamentals/revenue/_index.json` | 月營收公告日落在 mover date ±2 日窗 |
| `broker_coverage` | `min(analyst_count_next / 20, 0.6)` | `fundamentals/eps/_index.json` | ≥5 家機構覆蓋；分數上限 0.6 (不是觸發、只是 context) |

**Direction alignment**：`institutional_flow` 對 gainer 只計正向 net；
若法人逆勢（漲但賣超）, score = 0、evidence 改寫成「散戶推動」並進
`narrative_hints` 提示 chatbot。

## Confidence / calibration

⚠️ 權重目前是工程啟發式 (`MIN_THEME_PEERS=3`, `score formulas`)。要做歷史
校準需要 ground-truth：抓過去 60 天 Top 100 大漲股，人工或既有研究員
標真正原因，回測 weight。**v1 跑出來品質可用，但不是科學數值。**

## Run

```powershell
$BRAIN = "E:\SinoBrain-data"
# defaults to latest movers/<date>.json
bun run src/cli.ts jobs submit attribution-gather --follow `
  --params "{\"brain_dir\":\"$BRAIN\",\"source\":\"metabase\"}"

# pin a date (must have movers/<date>.json from E1)
bun run src/cli.ts jobs submit attribution-gather --follow `
  --params "{\"brain_dir\":\"$BRAIN\",\"source\":\"metabase\",\"date\":\"2026-05-27\"}"
```

## Pipeline order

1. `movers-detect` (E1) — writes `movers/<date>.json`
2. `attribution-gather` (E2, this) — reads the movers, writes `attribution/<date>/`
3. `gen-ticker-pages.ts` (E3) — wiki 加「近期動能與可能原因」段引用 attribution

## Scope cap

- Processes `top_gainers ∪ top_turnover` from movers JSON, dedup'd, cap 50.
- Top losers intentionally skipped — project goal is "客戶促動交易機會" =
  漲幅歸因，not 跌幅。Easy to extend (add `top_losers` to dedup pool).

## Pitfalls

- `concept-groups.json` 含許多 trailing-space tags — handler `.trim()` 前不會
  match。已修。
- `mean()` 對空陣列回傳 0；大盤 avg 若有問題會誤導 theme_rotation 的 excess。
  目前 filter 到 4 碼一般股取均，跟 mover-detect 一致。
- news_catalyst 從 disk 撈 (parse frontmatter + body wikilinks)，沒走 DB。
  好處是不依賴 extract 是否跑過；壞處是 disk 跟 DB 偶爾不同步。
- broker_coverage 只看 next-year analyst_count，所以一檔今年覆蓋高、明年沒覆蓋
  的會被低估。

## Storage

`attribution/` 是 db_only (已在 `gbrain.yml`)，跟 `movers/` 一起。
re-runnable from movers + 既有資料源，不用進 git。
