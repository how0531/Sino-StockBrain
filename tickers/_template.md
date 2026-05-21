---
type: ticker
slug: tickers/_template
title: "<公司名稱> (<TICKER>)"
exchange: TWSE          # TWSE / TPEX / NASDAQ / NYSE / HKEX / SSE / SZSE
ticker: "2330"          # 字串：保留前導零，避免 YAML 把 "0050" 變成 50
market: TW              # TW / US / HK / CN
sectors:                # 用 slug 列表，可多個。對應到 sectors/ 下的頁面。
  - sectors/semiconductor-foundry
themes:                 # 對應 themes/ 下的頁面。用來抓主題熱度。
  - themes/ai-infrastructure
isin: TW0002330008      # 選填，方便跨資料源 join
adr_ticker: TSM         # 選填，台股有 ADR 時填美股 ticker
inception: 1987-02-21   # 上市/掛牌日期
status: active          # active / delisted / suspended
watchlist_tier: core    # core / extended / experimental（決定 cron 抓的頻率）
---

# <公司名稱> (<TICKER>)

> One-liner 公司業務描述。例：「全球最大晶圓代工廠，掌握 5nm 以下先進製程。」

## Business Segments

- **<事業群 A>** — 佔營收 X%，主要客戶 [[tickers/aapl]]、[[tickers/nvda]]
- **<事業群 B>** — 佔營收 Y%

## Supply Chain & Relationships

- 供應商：[[companies/asml]]（曝光機）、[[tickers/3008]] (大立光，光學)
- 客戶：[[tickers/nvda]]、[[tickers/aapl]]、[[tickers/amd]]
- 競爭對手：[[tickers/005930]] (Samsung)、[[tickers/intc]]
- 同業：[[tickers/2454]] (聯發科)

## Key Catalysts to Watch

- **法說會** — 通常每季度，IR 信箱 `ir@example.com`
- **重大事件**：制程節點 ramp、晶圓售價、CapEx 指引
- **產業循環指標**：北美半導體設備 BB ratio、SEMI 月報

## Historical Milestones

<!-- timeline -->
- 1987-02-21 — 上市掛牌
- 2020-Q4 — 5nm 量產
- 2024-Q1 — 美國 Arizona 廠首批量產
