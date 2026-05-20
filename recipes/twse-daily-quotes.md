---
id: twse-daily-quotes
name: TWSE Daily Quotes
version: 0.1.0
description: 每日收盤後拉取台灣證交所所有上市股票的 OHLCV，寫入 brain 作為 anomaly detection 與 heat_score 的原始輸入。
category: sense
requires: []
secrets: []
health_checks:
  - type: http
    url: "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"
    label: "TWSE Open API"
setup_time: 5 min
cost_estimate: "$0 (TWSE Open API 免費、無需 API key)"
---

# TWSE Daily Quotes — 台股每日收盤行情拉取

每個交易日台股收盤後 (~14:30 TW)，自動拉取證交所所有上市股票的 OHLCV，
寫入 `prices/twse/YYYY-MM-DD/<code>.md`，供 dream cycle 的 `find_anomalies` 偵測
異常成交量、價量背離、cohort 級的 sector heatmap。

## Architecture

```
TWSE OpenAPI (免費 GET，無需 token)
  ↓
gbrain Minion job (name=twse-daily-quotes)
  ↓ filter by watchlist (tickers/ 下已有頁面的 ticker_code)
  ↓
Brain Repo:
  prices/twse/YYYY-MM-DD/2330.md   ← 每檔個股 + 該日資料
  prices/twse/YYYY-MM-DD/_summary.md ← 當日全市場異常清單
```

## Why a Minion job, not a shell cron

- **Stall detection** — 抓 fail / 網路 timeout 自動重試
- **Idempotency** — `idempotency_key = twse-daily-quotes:<YYYY-MM-DD>` 不會重複抓同一天
- **可追蹤** — `gbrain jobs list --name twse-daily-quotes` 看歷史
- **與 dream cycle 銜接** — 收盤後 → quotes → anomalies → market-heat → daily digest，一條 DAG

## Setup

### 1. 確認 handler 已註冊

執行：

```bash
GBRAIN_ALLOW_SHELL_JOBS=1 gbrain jobs work --queue default &
```

啟動時應看到 stderr：

```
[minion worker] twse-daily-quotes handler enabled
```

### 2. 提交第一個測試 job

```bash
gbrain jobs submit twse-daily-quotes \
  --params '{"date":"today","watchlist_only":true}' \
  --follow
```

`date: "today"` 會自動推算當天（週末會 abort）。
`watchlist_only: true` 只寫入 `tickers/` 已存在的個股，省 disk + dedup。

### 3. 排程：每個交易日 15:00 TW 自動跑

```bash
gbrain jobs submit twse-daily-quotes \
  --params '{"date":"today","watchlist_only":true}' \
  --idempotency-key "twse-daily-quotes:$(date +%F)" \
  --max-stalled 3 \
  --timeout-ms 120000
```

把這行包到 systemd timer / launchd / GitHub Actions / autopilot job spec 都可以。
建議走 autopilot：

```yaml
# autopilot 設定 (簡化示意)
jobs:
  - name: twse-daily-quotes
    cron: "0 15 * * 1-5"  # 週一到週五 15:00 TW
    timezone: Asia/Taipei
    params:
      date: today
      watchlist_only: true
```

## Output Schema

每個個股檔案 (`prices/twse/2026-05-20/2330.md`)：

```markdown
---
type: price_snapshot
slug: prices/twse/2026-05-20/2330
ticker: "2330"
exchange: TWSE
date: 2026-05-20
source: twse-openapi
ohlcv:
  open: 1095
  high: 1100
  low: 1090
  close: 1095
  volume: 23456789
  trades: 45678
  turnover: 25678901234
change_pct: 0.46
---

# TSMC (2330) — 2026-05-20

成交量 23.5M 股，較 30 日均量 [todo] %。

關聯：[[tickers/2330]]
```

當日 summary (`prices/twse/2026-05-20/_summary.md`)：

```markdown
---
type: market_summary
slug: prices/twse/2026-05-20/_summary
date: 2026-05-20
market: TWSE
---

# TWSE 2026-05-20 Daily Summary

- 漲跌家數：N 漲 / M 跌 / K 平盤
- 成交量：XXX 億
- 異常成交量個股 (>3x 30 日均量)：
  - [[tickers/2330]] +X.X%, vol = N.N×
  - ...
```

## Heat Signal Wiring

這份原始資料是後續所有訊號的基礎：

1. **`find_anomalies('ticker', sigma=2.0)`** — 跨日成交量 z-score
2. **`market-heat phase`** — 拉 watchlist 個股的 5/10/20/60 日成交量均量，算「異常倍數」
3. **`gbrain salience`** — 把 `change_pct × volume_ratio` 寫進 emotional_weight
4. **`patterns` phase** — 跨日找出「連 3 天異常成交量」的個股聚類

## Limits and Known Issues

- **TWSE Open API rate limit** — 沒有官方明文，實測 1 req/s 安全
- **盤中無資料** — STOCK_DAY_ALL 是收盤後資料；要盤中即時需另接 Fugle / 元大 API
- **週末/國定假日** — handler 偵測非交易日會 early-exit 並標記 `skipped: holiday`
- **歷史回填** — 改 params: `{"date":"2026-05-15"}` 可回填單日。多日回填寫 shell loop。

## Next Steps

- [ ] 接 TWSE 三大法人買賣超 (`recipes/twse-institutional-flow.md`)
- [ ] 接 MOPS 重大訊息 (`recipes/twse-mops-announcements.md`)
- [ ] 接美股對應 (`recipes/sec-daily-quotes.md` via Polygon / Alpha Vantage)
