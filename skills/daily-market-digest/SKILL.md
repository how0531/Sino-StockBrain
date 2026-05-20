---
name: daily-market-digest
version: 0.1.0
description: |
  Compose today's internal market digest for analysts. Pulls the heat-score
  ranking, cross-references with news + institutional flow, narrates each
  top ticker with a fact-only summary. Output is for INTERNAL analysts —
  before any push to clients it must pass through the compliance filter
  (not yet built; this skill explicitly does NOT add buy/sell language).
triggers:
  - "市場日報"
  - "今日熱門個股"
  - "盤後分析"
  - "daily market digest"
  - "今日 brain 重點"
  - "今天最熱的股票"
tools:
  - submit_job
  - get_page
  - search
  - list_pages
  - graph_query
mutating: true
writes_pages:
  - playbooks/digests/<date>.md
---

# Daily Market Digest

## Contract

This skill guarantees:
- One markdown digest per trading day at `playbooks/digests/<date>.md`
- All cited tickers are wikilinked to `[[tickers/XXXX]]`
- All claims trace back to a source page (`prices/`, `institutional-flow/`,
  `news/`) — no fabricated numbers
- **NO buy/sell language**. This is a facts + framing document, not a
  recommendation. The compliance filter is a separate downstream layer;
  this skill is its upstream input
- Idempotent — running twice on the same date produces the same digest

## Phases

### Phase 1: Ensure heat report exists

Check whether `playbooks/heat/<date>.md` already exists. If not, submit
the `market-heat` job and wait for it to complete:

```bash
gbrain jobs submit market-heat \
  --params '{"brain_dir":"<brain_dir>","date":"<date>"}' \
  --follow
```

Read the resulting heat report. It is your scoring spine — the top N
tickers by heat_score are your digest candidates. Do NOT make up your own
ranking; the formula is documented in `recipes/market-heat.md`.

### Phase 2: Cross-reference with news

For each Top 5 ticker from the heat report, read its news summary entry:

```bash
gbrain get_page news/<date>/_summary
```

Find the actual news articles mentioning the ticker:

```bash
# Articles in news/<date>/ that wikilink to the ticker
grep -l "tickers/<ticker>" news/<date>/*.md
```

Read 2-3 of the most relevant article bodies to understand the news context.

### Phase 3: Cross-reference with institutional flow

For each Top 5 ticker, read its flow snapshot:

```bash
gbrain get_page institutional-flow/twse/<date>/<ticker>
```

Note the direction (淨買 vs 淨賣), magnitude, and which of the three
sub-categories (外資 / 投信 / 自營) is the largest contributor.

### Phase 4: Cross-reference with the ticker's brain page

```bash
gbrain get_page tickers/<ticker>
```

Pull out:
- Business segments most likely affected
- Recent timeline milestones
- Linked themes (`themes/passive-components`, `themes/ai-infrastructure`)
- Linked supply-chain peers (other tickers it references)

### Phase 5: Compose the digest

Use the output format below. Each Top 5 ticker gets a section. Write the
narrative in zh-TW, factual tone, no buy/sell language.

### Phase 6: Write the digest

```bash
gbrain put_page playbooks/digests/<date> --content "<assembled_markdown>"
```

If you have file-write access, write directly:
`<brain_dir>/playbooks/digests/<date>.md`.

## Output Format

```markdown
---
type: market_digest
slug: playbooks/digests/<date>
date: <date>
market: TWSE
audience: internal_analyst
heat_report_ref: playbooks/heat/<date>
status: draft
---

# 市場日報 — <date>

> 內部分析師用。發給客戶前必須經 compliance filter。本文僅描述事實與背景，
> 不含個股操作建議。

## 今日 Top 5 熱門個股

### 1. <ticker_name> ([[tickers/XXXX]]) — heat <NN>

**訊號摘要**：法人 <XX>，量價 <YY>，新聞 <ZZ>

**法人籌碼**：外資 <淨買/淨賣> <N> 萬股，投信 <…>，自營 <…>。
強度為當日成交量 <pct>%。

**量價**：收盤 <price>，當日 <±X.X%>，成交量 <vol> 股（<X>σ 異常 / 中位 <X>x）

**新聞背景**：當日被提及 <N> 次。主要敘事包括 [[news/<date>/<article-slug>]] (<一句摘要>)、[[news/<date>/<另一篇>]] (<一句摘要>)。

**關聯**：所屬主題 [[themes/<theme>]]，供應鏈相關 [[tickers/<peer>]]、
[[tickers/<peer2>]]。

---

### 2. <ticker_name> ([[tickers/XXXX]]) — heat <NN>

(同上格式)

---

## 主題層級觀察

從 Top 20 個股的主題分布看，本日訊號集中在：

- [[themes/passive-components]]：N 檔在 Top 20
- [[themes/ai-infrastructure]]：M 檔在 Top 20

(2-3 句敘述產業層的可能訊號 — 必須對應到具體已連結的證據)

## 訊號可用性

- prices: ✓ / ✗
- institutional_flow: ✓ / ✗
- news: ✓ / ✗

訊號缺失時，依賴該訊號的個股排名可能失真。下游使用者注意。

關聯：[[playbooks/heat/<date>]]、[[playbooks]]
```

## Compliance Boundary (CRITICAL — read before writing)

This digest is for INTERNAL analysts. Even so, do NOT write any of:

- ❌ 「建議買進」、「建議賣出」、「應加碼」、「應減碼」
- ❌ 「目標價」未引用賣方研報來源 (必須帶 `[[analyst-notes/...]]` 連結)
- ❌ 「漲到 X」、「跌破 Y」等未來預測語言

Acceptable framing:

- ✅ 「外資連 3 日買超」(事實)
- ✅ 「分析師目標價自 X 上修至 Y」(引用 source)
- ✅ 「成交量為 30 日均量 5 倍」(事實)
- ✅ 「下週法說會將揭露 Q1 毛利率指引」(事件)
- ✅ 「庫存週轉天數降至 90 天以下」(財報事實)

When in doubt: rewrite as observation, not prescription.

The compliance filter (separate skill, future work) will scan for forbidden
phrases before any push to client-prep. Don't rely on it — write clean here.

## When NOT to invoke this skill

- Single-ticker deep-dive → use `skills/query/SKILL.md` with a ticker slug
- "Why is X moving today" investigation → manual: read prices + flow + news
  in that order
- Custom date range / multi-day → not yet supported; this skill is per-day
- Client-facing summary → DOES NOT BELONG HERE. Internal-only.

## Filing Rules

See `skills/_brain-filing-rules.md`. This skill writes to:

- `playbooks/digests/<YYYY-MM-DD>.md` — daily internal digest (db_tracked)

Does NOT write to `client-prep/`. That's a separate publish step.
