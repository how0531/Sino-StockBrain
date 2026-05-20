/**
 * `twse-daily-quotes` job handler.
 *
 * Pulls daily OHLCV for every TWSE-listed stock through the `StockDataSource`
 * adapter (default: mock; switchable to twse-openapi or future customer-db),
 * filters to the operator's watchlist (the tickers/ directory), and writes
 * one markdown snapshot per ticker under
 * `<brain_dir>/prices/twse/<YYYY-MM-DD>/<code>.md` plus a `_summary.md`.
 *
 * Why an adapter rather than direct HTTP: the customer's real ticker DB will
 * eventually back this. Adapter pattern lets us keep the handler stable
 * across the swap — only the `source` param changes.
 *
 * What this handler does NOT do (kept intentionally narrow):
 *   - No DB writes. Output goes to disk; `gbrain sync` ingests it next pass.
 *   - No anomaly detection. That's the dream cycle's job.
 *   - No LLM calls.
 *
 * Trust model: NOT in PROTECTED_JOB_NAMES — no RCE surface, no LLM cost.
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MinionJobContext } from '../types.ts';
import { UnrecoverableError } from '../types.ts';
import type { DailyQuote, MarketSnapshot } from '../../data-sources/stock-data.ts';
import { resolveStockDataSource } from '../../data-sources/stock-data.ts';
import { readWatchlist } from '../../data-sources/mock-stock-data.ts';

export interface TwseDailyQuotesParams {
  /** Brain repo absolute path. REQUIRED. */
  brain_dir: string;
  /** Target trading day. Accepts 'today' or 'YYYY-MM-DD'. Default 'today'. */
  date?: string;
  /** Restrict output to tickers/<code>.md members. Default true (saves disk). */
  watchlist_only?: boolean;
  /** Data source: 'mock' | 'twse-openapi'. Default 'mock' until the
   *  customer DB adapter lands. */
  source?: string;
}

export interface TwseDailyQuotesResult {
  status: 'ok' | 'skipped';
  reason?: string;
  date: string;
  source: string;
  rows_fetched: number;
  rows_written: number;
  output_dir: string;
}

export async function twseDailyQuotesHandler(
  ctx: MinionJobContext,
): Promise<TwseDailyQuotesResult> {
  const params = validateParams(ctx.data);
  const date = resolveDate(params.date ?? 'today');
  const sourceName = params.source ?? 'mock';

  if (isNonTradingDay(date)) {
    return {
      status: 'skipped',
      reason: 'non-trading day (weekend)',
      date,
      source: sourceName,
      rows_fetched: 0,
      rows_written: 0,
      output_dir: '',
    };
  }

  const outputDir = join(params.brain_dir, 'prices', 'twse', date);
  mkdirSync(outputDir, { recursive: true });

  const watchlist = params.watchlist_only !== false
    ? readWatchlist(params.brain_dir)
    : null;

  await ctx.log(
    `[twse-daily-quotes] source=${sourceName} date=${date}` +
    (watchlist ? ` watchlist=${watchlist.size}` : ' (all tickers)'),
  );

  const dataSource = await resolveStockDataSource(sourceName, {
    brain_dir: params.brain_dir,
  });
  const snapshot: MarketSnapshot = await dataSource.getDailySnapshot('TWSE', date);

  let written = 0;
  const writtenRows: DailyQuote[] = [];
  for (const quote of snapshot.quotes) {
    if (ctx.signal.aborted) throw new Error('aborted');
    if (watchlist && !watchlist.has(quote.ticker)) continue;

    const filePath = join(outputDir, `${quote.ticker}.md`);
    if (existsSync(filePath)) continue; // skip-if-exists for cheap resume

    writeFileSync(filePath, renderQuoteMarkdown(quote, snapshot.source), 'utf8');
    writtenRows.push(quote);
    written++;
  }

  // Always rewrite summary so it reflects current full snapshot.
  const summaryPath = join(outputDir, '_summary.md');
  writeFileSync(summaryPath, renderSummary(snapshot, writtenRows), 'utf8');

  await ctx.log(
    `[twse-daily-quotes] wrote ${written} snapshots + summary to ${outputDir}`,
  );

  return {
    status: 'ok',
    date,
    source: snapshot.source,
    rows_fetched: snapshot.quotes.length,
    rows_written: written,
    output_dir: outputDir,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function validateParams(data: Record<string, unknown>): TwseDailyQuotesParams {
  if (typeof data.brain_dir !== 'string' || !data.brain_dir) {
    throw new UnrecoverableError(
      'twse-daily-quotes: missing required param "brain_dir" (absolute path to brain repo)',
    );
  }
  if (data.date !== undefined && typeof data.date !== 'string') {
    throw new UnrecoverableError('twse-daily-quotes: "date" must be a string ("today" or YYYY-MM-DD)');
  }
  if (data.watchlist_only !== undefined && typeof data.watchlist_only !== 'boolean') {
    throw new UnrecoverableError('twse-daily-quotes: "watchlist_only" must be boolean');
  }
  if (data.source !== undefined && typeof data.source !== 'string') {
    throw new UnrecoverableError('twse-daily-quotes: "source" must be a string');
  }
  return {
    brain_dir: data.brain_dir,
    date: data.date as string | undefined,
    watchlist_only: data.watchlist_only as boolean | undefined,
    source: data.source as string | undefined,
  };
}

function resolveDate(input: string): string {
  if (input === 'today') {
    const tw = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const y = tw.getFullYear();
    const m = String(tw.getMonth() + 1).padStart(2, '0');
    const d = String(tw.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    throw new UnrecoverableError(`twse-daily-quotes: invalid date "${input}" (use "today" or YYYY-MM-DD)`);
  }
  return input;
}

function isNonTradingDay(date: string): boolean {
  // Weekend short-circuit. Holiday calendar (TWSE-published) not wired yet.
  const dow = new Date(date + 'T08:00:00+08:00').getUTCDay();
  return dow === 0 || dow === 6;
}

function renderQuoteMarkdown(quote: DailyQuote, sourceName: string): string {
  return `---
type: price_snapshot
slug: prices/twse/${quote.date}/${quote.ticker}
ticker: "${quote.ticker}"
name: "${escapeYamlString(quote.name)}"
exchange: TWSE
date: ${quote.date}
source: ${sourceName}
ohlcv:
  open: ${quote.open}
  high: ${quote.high}
  low: ${quote.low}
  close: ${quote.close}
  prev_close: ${quote.prev_close}
  volume: ${quote.volume}
  trades: ${quote.trades}
  turnover: ${quote.turnover}
change: ${quote.change}
change_pct: ${quote.change_pct}
---

# ${quote.name} (${quote.ticker}) — ${quote.date}

收盤 **${quote.close}**（漲跌 ${quote.change >= 0 ? '+' : ''}${quote.change}，當日 ${quote.change_pct >= 0 ? '+' : ''}${quote.change_pct}%）。
成交量 ${quote.volume.toLocaleString()} 股 / ${quote.trades.toLocaleString()} 筆，成交金額 ${(quote.turnover / 1e8).toFixed(2)} 億 TWD。

關聯：[[tickers/${quote.ticker}]]
`;
}

function renderSummary(snapshot: MarketSnapshot, written: DailyQuote[]): string {
  const all = snapshot.quotes;
  const up = all.filter((r) => r.change > 0).length;
  const down = all.filter((r) => r.change < 0).length;
  const flat = all.length - up - down;
  const totalTurnover = all.reduce((s, r) => s + r.turnover, 0);

  const topByVolume = [...all]
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 10);

  const topGainers = [...all]
    .sort((a, b) => b.change_pct - a.change_pct)
    .slice(0, 5);

  const topLosers = [...all]
    .sort((a, b) => a.change_pct - b.change_pct)
    .slice(0, 5);

  const fmtRow = (r: DailyQuote): string =>
    `- [[tickers/${r.ticker}]] ${r.name} — close ${r.close}, ${r.change_pct >= 0 ? '+' : ''}${r.change_pct}%, vol ${r.volume.toLocaleString()}`;

  const writtenLinks = written.map(fmtRow).join('\n');

  return `---
type: market_summary
slug: prices/twse/${snapshot.date}/_summary
date: ${snapshot.date}
market: TWSE
source: ${snapshot.source}
---

# TWSE ${snapshot.date} Daily Summary

- 漲跌家數：${up} 漲 / ${down} 跌 / ${flat} 平盤
- 總成交金額：${(totalTurnover / 1e8).toFixed(2)} 億 TWD
- 來源筆數：${all.length}
- 寫入 watchlist 筆數：${written.length}

## Top 10 by Volume

${topByVolume.map(fmtRow).join('\n') || '(empty)'}

## Top 5 Gainers

${topGainers.map(fmtRow).join('\n') || '(empty)'}

## Top 5 Losers

${topLosers.map(fmtRow).join('\n') || '(empty)'}

## Watchlist Snapshots Written

${writtenLinks || '(no watchlist tickers matched today)'}
`;
}

function escapeYamlString(s: string): string {
  return s.replace(/"/g, '\\"');
}
