# Recipe: `fundamentals-eps`

Pulls the **monthly analyst-consensus EPS snapshot** (current-year + next-year
forecast + TTM actual) for every listed TWSE/TPEX ticker through the
`StockDataSource` adapter and writes:

```
<brain_dir>/fundamentals/eps/<YYYY-MM>/
  <code>.md         # per-ticker snapshot with frontmatter + body
  _summary.md       # top 15 next-year / current-year EPS growth (gated by ≥3 analysts)
  _index.json       # { year_month, source, count, by_ticker: { code -> ConsensusEPS } }
```

## Source

`cmoney."月機構預估盈餘與EPS"` — monthly snapshot rolled up from broker
estimates. One row per ticker per snapshot month. The handler always
resolves the latest available `年月` from the source unless `year_month`
is pinned.

This is **distinct** from `fundamentals-revenue`: revenue uses the actual
`月營收(成長與達成率)` (公告日 ~10th of following month); EPS uses analyst
forecasts as of the snapshot month.

## Confidence gating

Top-N lists in `_summary.md` filter to tickers with `analyst_count ≥ 3`
(or `analyst_count_next ≥ 3` for next-year rankings). A 1-broker forecast
isn't a consensus and would otherwise dominate growth rankings (lone
analyst with an optimistic call). The threshold lives at the top of
`fundamentals-eps.ts` (`MIN_ANALYSTS_FOR_TOP`).

## Run

```powershell
$BRAIN = "E:\SinoBrain-data"
bun run src/cli.ts jobs submit fundamentals-eps --follow `
  --params "{\"brain_dir\":\"$BRAIN\",\"source\":\"metabase\"}"
```

Pin a month (e.g. retro-fill 2026-04):

```powershell
bun run src/cli.ts jobs submit fundamentals-eps --follow `
  --params "{\"brain_dir\":\"$BRAIN\",\"source\":\"metabase\",\"year_month\":\"202604\"}"
```

## Frontmatter

```yaml
type: eps_snapshot
slug: fundamentals/eps/2026-05/2330
ticker: "2330"
year_month: "202605"
updated_date: 2026-05-13
ttm_eps: 74.38                      # 累計近四季 EPS (actual)
current_year_eps: 99.26             # 今年機構估
next_year_eps: 126.55               # 明年機構估 — the headline
current_year_growth_pct: 49.8
next_year_growth_pct: 27.5          # computed: (next - current) / current * 100
analyst_count: 23
analyst_count_next: 18
pe_low: 22.01
pe_high: 23.27
```

Any of `*_eps`/`*_growth_pct`/`analyst_count*` may be `null` when the
ticker has no broker coverage for that year — the chatbot should treat
null as "no consensus" rather than "0 EPS".

## Downstream consumers

- **`gen-ticker-pages.ts`** reads the latest `_index.json` and includes the
  consensus EPS lines in each ticker wiki's `財務脈動` section.
- `_summary.md` already answers "明年預估 EPS 成長前 N 的股票有哪些" — chatbot
  can serve that directly without computation.

## Pitfalls

- `明年機構估稅後EPS` is often `NaN` (string) when no analyst covers the
  next year (typical for small-caps); `numOrNull` in the metabase adapter
  treats this as `null`. Don't coerce to 0.
- `預估年稅後EPS成長(%)` (current_year_growth_pct) compares the consensus to
  **last-year actual**, not last-year forecast. The `next_year_growth_pct`
  this handler computes is **forecast-vs-forecast** — different baseline.
- The snapshot reflects analyst consensus AS OF the snapshot month; brokers
  revise frequently. `updated_date` is the freshest broker update reflected.

## Storage

`fundamentals/` is **db_only** in `gbrain.yml` (already configured by
`fundamentals-revenue`). Per-ticker `.md` files are skip-if-exists;
`_summary.md` and `_index.json` are always overwritten.
