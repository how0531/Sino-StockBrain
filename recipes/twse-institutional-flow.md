---
id: twse-institutional-flow
name: TWSE Institutional Flow
version: 0.1.0
description: 每個交易日收盤後拉取三大法人（外資、投信、自營商）對台股 watchlist 個股的買賣超，寫入 brain。是 sino-stockbrain 的 #1 熱度訊號。
category: sense
requires: []
secrets: []
health_checks: []
setup_time: 5 min
cost_estimate: "$0 (mock mode); 視真實資料源而定"
---

# TWSE Institutional Flow — 三大法人買賣超

每個交易日收盤後拉取「外資及陸資 / 投信 / 自營商」對 watchlist 個股的買賣超，
寫入 `institutional-flow/twse/YYYY-MM-DD/<code>.md`。

**為什麼是 #1 熱度訊號**：外資買賣超對台股股價有領先效應（典型 1-3 日），
是分析師最關注的盤後訊號。投信反映中頻動能輪動；自營商主要是避險/造市，
spike 時通常代表權證/選擇權結算前後的對沖部位調整。

## Architecture

```
Stock Data Source (mock | twse-openapi | future: customer-db)
  ↓
gbrain Minion job (name=twse-institutional-flow)
  ↓
Brain Repo:
  institutional-flow/twse/YYYY-MM-DD/2330.md  ← 每檔個股一檔
  institutional-flow/twse/YYYY-MM-DD/_summary.md  ← Top inflow/outflow
```

## Mock vs Real Data

預設 `source=mock`。Mock 資料是 deterministic（同 `(ticker, date)` 永遠回相同數字），
且與同日的 daily-quotes 輸出相關（買賣超與當日漲跌正相關），方便端到端測試。

未來切換到你的個股資料庫只要：
1. 在 `src/core/data-sources/` 新增一個 `customer-db-stock-data.ts`
   實作 `StockDataSource` interface
2. 在 `stock-data.ts:resolveStockDataSource()` 加一個 `case 'customer-db'`
3. 提交 job 時改 `--params '{"source":"customer-db",...}'`

handler 程式碼完全不動。

## Setup

提交一個 job：

```bash
gbrain jobs submit twse-institutional-flow \
  --params "{\"brain_dir\":\"$(pwd)\",\"date\":\"today\",\"source\":\"mock\"}" \
  --idempotency-key "twse-institutional-flow:$(date +%F)" \
  --follow
```

完成後檢視：

```bash
ls institutional-flow/twse/$(date +%F)/
cat institutional-flow/twse/$(date +%F)/_summary.md
```

## Heat Signal Wiring

這份資料是 heat_score 的核心輸入：

```
heat_score(ticker, day) =
    w1 × institutional_intensity   ← 來自這個 handler 的 net_intensity
  + w2 × volume_anomaly            ← 來自 twse-daily-quotes
  + w3 × news_density              ← 來自未來的 news handler
  + w4 × analyst_revision          ← 來自未來的 analyst-notes handler
  + w5 × catalyst_proximity        ← 來自未來的 calendar handler
```

權重 w1-w5 不寫死，由 `gbrain calibration` 系統從事後驗證學習。

## Output Schema

每檔個股檔案（`institutional-flow/twse/2026-05-20/2330.md`）：

```markdown
---
type: institutional_flow_snapshot
slug: institutional-flow/twse/2026-05-20/2330
ticker: "2330"
exchange: TWSE
date: 2026-05-20
source: mock
foreign_net: 5234000
trust_net: 234000
dealer_net: -120000
total_net: 5348000
net_intensity: 0.1823
---

# 台積電 (2330) — 三大法人 2026-05-20

- 外資及陸資：+5,234,000 股
- 投信：+234,000 股
- 自營商：-120,000 股
- 合計：+5,348,000 股 (強度 18.23% of vol)

關聯：[[tickers/2330]]、[[prices/twse/2026-05-20/2330]]
```

## Next Steps

- [ ] 接 `recipes/finance-news-rss.md`（新聞密度訊號）
- [ ] 新增 cycle phase `src/core/cycle/market-heat.ts`（把這些訊號整合成 heat_score）
- [ ] 接美股對應（外資對台股 vs 機構持倉變動 13F）
