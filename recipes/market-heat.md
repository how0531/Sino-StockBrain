---
id: market-heat
name: Market Heat Scorer
version: 0.1.0
description: 把當日三個訊號流（量價 / 法人 / 新聞密度）合成成單一 heat_score（0-1）並排序，產出 playbooks/heat/<date>.md。Daily digest 的上游必要步驟。
category: synthesise
requires:
  - twse-daily-quotes
  - twse-institutional-flow (optional)
  - news-ingest (optional)
secrets: []
health_checks: []
setup_time: 2 min
cost_estimate: "$0 (純函式計算，零 LLM 呼叫)"
---

# Market Heat Scorer — 訊號合成

把當天三條 sense 線（量價 / 法人 / 新聞密度）合成成單一 `heat_score`（0-1），
按分數降冪排序，產出 `playbooks/heat/<YYYY-MM-DD>.md`。

這是 daily digest 的「上游必要步驟」— digest skill 需要這份排名才能挑出
「今天值得寫的個股」。

## Architecture

```
playbooks/heat/<date>.md  ←  market-heat 寫入
   ▲
   │
market-heat handler  ── 純函式計算 + disk read + disk write
   │
   ├─ <brain>/prices/twse/<date>/*.md             ← twse-daily-quotes
   ├─ <brain>/institutional-flow/twse/<date>/*.md ← twse-institutional-flow
   └─ <brain>/news/<date>/_summary.md             ← news-ingest
```

訊號缺失時，handler degrade gracefully — 缺資料的訊號貢獻 0，不會 abort。

## Formula

```
heat_score = w_inst × institutional_flow_signal
           + w_vol  × volume_anomaly_signal
           + w_news × news_density_signal
```

三個 signal 都先 normalise 到 [0,1]：

| Signal | 公式 | 直覺 |
|---|---|---|
| `institutional_flow` | `tanh(|net_intensity| × 10)` | 5% 強度→46 分，10%→76 分 |
| `volume_anomaly` | `tanh(|z-score| / 2)` | 2σ→96 分，3σ→99.5 分 |
| `news_density` | `min(mentions / 5, 1)` | 當日 5 次提及打滿分 |

預設權重（由使用者明確指定的訊號排序映射）：

| Weight | 預設值 | 理由 |
|---|---|---|
| `w_inst` | 0.45 | 使用者列為 #1 訊號 |
| `w_vol` | 0.30 | 量價異常 #2 |
| `w_news` | 0.25 | 新聞密度 #3 |

權重 **不寫死** — 任一 job 提交都可 override：

```bash
--params '{"weights":{"institutional_flow":0.5,"volume_anomaly":0.3,"news_density":0.2}}'
```

未來 calibration 系統會自動從事後表現調整權重。

## Setup

跑單日 heat：

```bash
gbrain jobs submit market-heat \
  --params "{\"brain_dir\":\"$(pwd)\",\"date\":\"2026-05-20\"}" \
  --follow
```

完成後 `playbooks/heat/2026-05-20.md` 內含：

- Top 20 排名表（含 rationale）
- Bottom 10（signal-quiet）
- 方法學註記

## Methodology Caveats

- **無 absolute 訊息** — heat_score 是「今天值得看」訊號，不是買賣建議
- **歷史資料 <10 日**：volume 訊號降階用 ratio against median，不算 z-score
- **新聞 cap at 5 mentions/day**：當日 20 次跟 5 次同分。 mock 階段夠用，
  接真實新聞源後可能要調整
- **法人籌碼向量化**：`net_intensity` 是有號的 (-1 to 1)，這個訊號取絕對值，
  不分多空。要分多空需要另一個 signal `net_direction`（v0.2 開發）

## Promotion Path

目前是獨立 Minion handler。未來想讓 `gbrain dream` 自動跑時，把計算邏輯
（`src/core/heat-score/compute.ts`）包進一個 `BaseCyclePhase` 子類別即可。
計算邏輯與 I/O 是分開的（compute.ts 是純函式）—— 包裝層改了，演算法不變。
