# Recipe: `fundamentals-revenue`

Pulls the **latest month's revenue (月營收)** for every listed TWSE/TPEX ticker
through the `StockDataSource` adapter and writes one markdown snapshot per
ticker plus a `_summary.md` (top 15 YoY up/down) and `_index.json`
(machine-readable map keyed by ticker code) under
`<brain_dir>/fundamentals/revenue/<YYYY-MM>/`.

## Cadence vs price/flow

月營收 is published **~10th of the following month** — a different cadence
than daily quotes and institutional flow. The handler resolves the latest
available `年月` from the source (never assumes it matches a trading date)
and stamps both `year_month` and `announce_date` (公告日) into every snapshot
so the as-of is always explicit and auditable.

Pin a specific month by passing `year_month: "YYYYMM"`; omit for "latest".

## Capability-gated source

Only the `metabase` source implements `getMonthlyRevenue`. Other sources
(`mock`, `twse-openapi`) return `status: "skipped"` cleanly. The data lives
in `cmoney."月營收(成長與達成率)"`.

## Run

```powershell
$BRAIN = "E:\SinoBrain-data"
bun run src/cli.ts jobs submit fundamentals-revenue --follow `
  --params "{\"brain_dir\":\"$BRAIN\",\"source\":\"metabase\"}"
```

Pin a month:

```powershell
bun run src/cli.ts jobs submit fundamentals-revenue --follow `
  --params "{\"brain_dir\":\"$BRAIN\",\"source\":\"metabase\",\"year_month\":\"202604\"}"
```

## Output

```
<brain_dir>/fundamentals/revenue/2026-04/
  2330.md           # per-ticker snapshot with frontmatter + body
  2454.md
  ...
  _summary.md       # top 15 YoY up/down
  _index.json       # { year_month, source, by_ticker: { code -> MonthlyRevenue } }
```

Each per-ticker snapshot carries:

```yaml
type: revenue_snapshot
slug: fundamentals/revenue/2026-04/2330
ticker: "2330"
year_month: "202604"
announce_date: 2026-05-08
revenue: 410725118000          # 元
revenue_yoy_pct: 17.5
revenue_mom_pct: -1.08
cum_yoy_pct: 29.95
ttm_yoy_pct: 27.98
```

## Downstream consumers

- **`gen-ticker-pages.ts`** reads `_index.json` to emit the "財務脈動" section
  in each `tickers/<code>.md` wiki page.
- **`extract links --source db`** wires `[[tickers/<code>]]` from each
  snapshot's body into the graph.

## Idempotency

Per-ticker snapshot files are **skip-if-exists** — re-running the handler
for the same `year_month` never rewrites them. `_summary.md` and
`_index.json` are always overwritten (cheap, regenerable).

To force a rewrite of a single ticker, delete its `.md` and re-run.

## Storage

`fundamentals/` is **db_only** in `gbrain.yml` — bulk machine-generated,
not version-controlled, restorable from the brain DB via
`gbrain export --restore-only`.

## Pitfalls

- `年月` is `'YYYYMM'` (string), NOT a `Date`. Don't try to parse it as
  ISO-8601.
- Revenue is in **元** in the snapshot (the cmoney column is `千` — the
  handler multiplies ×1000). Display formatting (`億`) happens at render
  time.
- The TWSE/TPEX filter uses `match("股票代號", '^[0-9]{4}$')` to drop
  non-numeric or warrant-style codes.
