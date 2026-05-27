# Recipe: `movers-detect`

**Phase E step 1** — daily mover snapshot. The entry point of the attribution
layer: pick "who moved today" so subsequent handlers (E2 attribution-gather)
know which tickers to spend evidence-gathering budget on.

## Output

```
<brain_dir>/movers/<YYYY-MM-DD>.json     # structured rankings, chatbot reads
<brain_dir>/movers/<YYYY-MM-DD>.md       # human summary
```

JSON shape:

```json
{
  "date": "2026-05-27",
  "source": "metabase",
  "top_n": 30,
  "universe_size": 1967,
  "top_gainers":  [{ "ticker": "...", "name": "...", "close": ..., "change_pct": ..., "volume": ..., "turnover": ... }, ...],
  "top_losers":   [...],
  "top_turnover": [...]
}
```

## Rankings

Three independent Top-N lists (a ticker can appear in multiple):

- **top_gainers** — highest `change_pct`
- **top_losers** — lowest `change_pct` (most negative)
- **top_turnover** — highest `turnover` (TWD traded); the "liquid heavyweights"
  that actually had real money behind the move

## Filtering

- Common stock only (`^\d{4}$`) — drops warrants, 特別股, ETF subclasses that
  share the same `cmoney."日收盤表排行"` table.
- 漲跌停 NOT dropped — they ARE movers, even if % is capped at ±10%.

## What's deliberately NOT here (yet)

- **volume_intensity** (today_volume / 20-day-avg) — would need a 20-day
  historical pull per ticker. Step 1b will add it; v1 ships with raw
  turnover as the "anyone actually traded this" proxy.
- **Per-mover attribution evidence** — that's E2 `attribution-gather`,
  which reads this JSON as its input list.

## Run

```powershell
$BRAIN = "E:\SinoBrain-data"
# latest available trading day, default top_n=30
bun run src/cli.ts jobs submit movers-detect --follow `
  --params "{\"brain_dir\":\"$BRAIN\",\"source\":\"metabase\"}"

# pin a date + custom Top N
bun run src/cli.ts jobs submit movers-detect --follow `
  --params "{\"brain_dir\":\"$BRAIN\",\"source\":\"metabase\",\"date\":\"2026-05-27\",\"top_n\":50}"
```

## Idempotency

`<date>.json` and `<date>.md` are always overwritten — the latest run is the
truth. No skip-if-exists (unlike per-ticker snapshots in revenue/EPS),
because there's only one file per date.

## Storage

Output goes under `movers/`. Add to `gbrain.yml` db_only — bulk machine-
generated, regenerable from the source.

## Downstream consumers

- **E2 `attribution-gather`** reads `top_gainers` (and `top_losers`/`top_turnover`
  if those are also in scope) to know which tickers to fan out evidence
  queries for.
- Chatbot can read `<date>.md` directly to answer "今天漲幅 / 跌幅 / 成交金額
  Top 10 是哪些股票".

## Pitfalls

- "Latest date" via `getLatestQuoteDate` is the source's latest day with
  ANY quote rows — may not match real calendar today (weekend / market
  close). Always check the `date` field in the result.
- A 漲停 in the top_gainers list at exactly +9.99 / +10.00% is by definition
  a capped move; attribution should weight 漲停 differently from "real"
  +9% moves (E2 handler note).
