---
id: compliance-filter
name: Compliance Filter
version: 0.1.0
description: 兩層合規審查 (deterministic regex + 可選 LLM judge)。讀分析師 digest，判斷可否對外推送，輸出 client-prep 或 violations report，並寫 audit JSONL。
category: govern
requires:
  - daily-market-digest (產出待審查 digest)
secrets: []
health_checks: []
setup_time: 2 min
cost_estimate: "$0 (Layer 1 only); ~$0.005-0.02 per digest with LLM judge (Sonnet)"
---

# Compliance Filter — 對外推送前的最後關卡

讀分析師 digest，跑兩層合規審查，依結果寫到三個目的地之一：

- ✅ `verdict=pass`   → `client-prep/<date>.md`（可推送）
- ⚠️ `verdict=review` → `playbooks/violations/<date>.md`（分析師處理）
- 🚫 `verdict=fail`   → `playbooks/violations/<date>.md`（不可推送）

無論結果為何，都會在 `~/.gbrain/audit/compliance-YYYY-Www.jsonl` 留一筆紀錄
（regulatory evidence — filter 確實跑過）。

## Architecture

```
playbooks/digests/<date>.md (input)
   │
   ▼
compliance-filter handler
   │
   ├─ Layer 1: deterministic-pass.ts
   │   - regex scan against BANNED_PATTERNS
   │   - 抓「建議買進/賣出」、「應加碼」、「目標價 X」(未引用)、「肯定會漲」
   │   - sub-ms, $0, always-on
   │
   ├─ Layer 2: llm-judge.ts (opt-in via --params '{"llm":true}')
   │   - gateway.chat() with rubric + digest
   │   - structured JSON output (verdict + violations + confidence)
   │   - fail-graceful: 任何 LLM 問題 → available=false，不影響 Layer 1
   │
   └─ aggregate.ts
       Decision logic:
         critical → fail
         warning only → review
         L2 verdict (no structured violation) → respect it
         else → pass
   │
   ▼
output + audit
```

## Try it

### Without LLM (Layer 1 only, $0)

```bash
gbrain jobs submit compliance-filter --follow \
  --params "{\"brain_dir\":\"$(pwd)\",\"date\":\"2026-05-20\"}"
```

### With LLM judge (requires ANTHROPIC_API_KEY)

```bash
gbrain jobs submit compliance-filter --follow \
  --params "{\"brain_dir\":\"$(pwd)\",\"date\":\"2026-05-20\",\"llm\":true}"
```

可指定模型：`"llm_model":"anthropic:claude-haiku-4-5"` 省錢。

## Rubric

See `src/core/compliance/rubric.ts:RUBRIC_TEXT_ZH` for the canonical text
both layers consume. Highlights:

### Critical（任一條 → fail）

- 個股買賣建議：「建議買進」、「應加碼」、「適合進場」、「可放空」
- 個人化指令：「您應該」、「建議您」
- 絕對化用詞：「肯定」、「必定」、「保證」

### Warning（→ review）

- 未引用的目標價、未引用的未來預測
- 評等變動沒帶 source

### Allowed

- 過去式事實
- 已引用目標價 (with `[[analyst-notes/...]]`)
- 條件式：「若 X 符合指引，可預期…」
- 中性事件預告：「下週法說會將揭露…」

## Output Shapes

### Pass — `client-prep/<date>.md`

原 digest 前面被替換成 approved frontmatter：

```yaml
---
type: client_prep_digest
slug: client-prep/2026-05-20
status: approved
compliance_verdict: pass
compliance_layer1_violations: 0
compliance_layer2_violations: 0
compliance_digest_hash: a1b2c3d4...
---
```

正文不動。下游 LINE bot / MCP 機構客戶端可安全讀。

### Fail / Review — `playbooks/violations/<date>.md`

```markdown
# Compliance Violations — 2026-05-20

**Verdict**: FAIL

## Violations (3)

### 1. 🚫 buy_sell_recommendation (critical) — caught by deterministic

**位置**: Top 5 個股 → 2330
**引文**: > 建議買進台積電
**建議改寫**: 改為「外資連 3 日買超」、「成交量為 30 日均量 5 倍」
...
```

分析師打開檔案，照建議改寫，重跑 compliance-filter，到 pass 為止。

## Audit Trail

每次跑都 append 一行到 `~/.gbrain/audit/compliance-YYYY-Www.jsonl`：

```json
{
  "ts": "2026-05-20T14:30:00.000Z",
  "date": "2026-05-20",
  "digest_path": "playbooks/digests/2026-05-20.md",
  "digest_hash": "a1b2c3d4...",
  "verdict": "pass",
  "layer1_violations": 0,
  "layer2_violations": 0,
  "llm_available": true,
  "llm_confidence": 0.92,
  "output_path": "client-prep/2026-05-20.md"
}
```

查 30 天紀錄：
```bash
cat ~/.gbrain/audit/compliance-*.jsonl | jq 'select(.verdict == "fail")' | head
```

## Cost Math (LLM Layer)

| Model | Input cost | 每 digest 約 (1500 tokens in + 500 out) |
|---|---|---|
| Haiku 4.5 | $1/M | ~$0.001 |
| Sonnet 4.6 | $3/M | ~$0.005 |
| Opus 4.7 | $5/M | ~$0.010 |

10 個 digest/天 × Sonnet = $1.50/月。建議用 Sonnet（合規任務需要謹慎理解）。

## Next Steps

- [ ] 加 RELAXED_RUBRIC：機構客戶可用較寬鬆的版本（允許條件式 forecast 等）
- [ ] 加 routing-eval fixtures
- [ ] 加 client-prep publish pipeline（compliance pass 後自動推 LINE/Email）
- [ ] 加 calibration loop：事後追蹤被 review/fail 的 digest 是否真的有問題
