/**
 * `twse-institutional-flow` job handler.
 *
 * Pulls daily 三大法人 (外資 / 投信 / 自營商) net buy/sell for every TWSE
 * watchlist ticker through the `StockDataSource` adapter, writes one
 * markdown snapshot per ticker under
 * `<brain_dir>/institutional-flow/twse/<YYYY-MM-DD>/<code>.md` plus a
 * `_summary.md` ranking the top inflow/outflow targets.
 *
 * Why this matters: institutional flow is the user's #1 heat signal. Foreign
 * buy-sell tends to lead price moves by 1-3 days; trust flow signals
 * mid-frequency rotation; dealer flow is mostly liquidity-provision noise
 * (but spikes can mean hedging activity around option/warrant expiries).
 *
 * Mock vs real: defaults to `source=mock` until the customer's ticker DB
 * lands. Mock data is correlated with the matching daily-quotes output for
 * the same `(ticker, date)` so flow + price tell a consistent story.
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MinionJobContext } from '../types.ts';
import { UnrecoverableError } from '../types.ts';
import type { InstitutionalFlow } from '../../data-sources/stock-data.ts';
import { resolveStockDataSource } from '../../data-sources/stock-data.ts';
import { readWatchlist } from '../../data-sources/mock-stock-data.ts';

export interface TwseInstitutionalFlowParams {
  brain_dir: string;
  date?: string;
  watchlist_only?: boolean;
  source?: string;
}

export interface TwseInstitutionalFlowResult {
  status: 'ok' | 'skipped';
  reason?: string;
  date: string;
  source: string;
  rows_fetched: number;
  rows_written: number;
  output_dir: string;
}

export async function twseInstitutionalFlowHandler(
  ctx: MinionJobContext,
): Promise<TwseInstitutionalFlowResult> {
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

  const outputDir = join(params.brain_dir, 'institutional-flow', 'twse', date);
  mkdirSync(outputDir, { recursive: true });

  const watchlist = params.watchlist_only !== false
    ? readWatchlist(params.brain_dir)
    : null;

  await ctx.log(
    `[twse-institutional-flow] source=${sourceName} date=${date}` +
    (watchlist ? ` watchlist=${watchlist.size}` : ' (all tickers)'),
  );

  const dataSource = await resolveStockDataSource(sourceName, {
    brain_dir: params.brain_dir,
  });
  const flows = await dataSource.getInstitutionalFlow('TWSE', date);

  let written = 0;
  const writtenRows: InstitutionalFlow[] = [];
  for (const flow of flows) {
    if (ctx.signal.aborted) throw new Error('aborted');
    if (watchlist && !watchlist.has(flow.ticker)) continue;

    const filePath = join(outputDir, `${flow.ticker}.md`);
    if (existsSync(filePath)) continue;

    writeFileSync(filePath, renderFlowMarkdown(flow, sourceName), 'utf8');
    writtenRows.push(flow);
    written++;
  }

  const summaryPath = join(outputDir, '_summary.md');
  writeFileSync(summaryPath, renderSummary(flows, writtenRows, date, sourceName), 'utf8');

  await ctx.log(
    `[twse-institutional-flow] wrote ${written} snapshots + summary to ${outputDir}`,
  );

  return {
    status: 'ok',
    date,
    source: sourceName,
    rows_fetched: flows.length,
    rows_written: written,
    output_dir: outputDir,
  };
}

// ---------------------------------------------------------------------------

function validateParams(data: Record<string, unknown>): TwseInstitutionalFlowParams {
  if (typeof data.brain_dir !== 'string' || !data.brain_dir) {
    throw new UnrecoverableError(
      'twse-institutional-flow: missing required param "brain_dir"',
    );
  }
  if (data.date !== undefined && typeof data.date !== 'string') {
    throw new UnrecoverableError('twse-institutional-flow: "date" must be a string');
  }
  if (data.watchlist_only !== undefined && typeof data.watchlist_only !== 'boolean') {
    throw new UnrecoverableError('twse-institutional-flow: "watchlist_only" must be boolean');
  }
  if (data.source !== undefined && typeof data.source !== 'string') {
    throw new UnrecoverableError('twse-institutional-flow: "source" must be a string');
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
    throw new UnrecoverableError(`twse-institutional-flow: invalid date "${input}"`);
  }
  return input;
}

function isNonTradingDay(date: string): boolean {
  const dow = new Date(date + 'T08:00:00+08:00').getUTCDay();
  return dow === 0 || dow === 6;
}

function renderFlowMarkdown(flow: InstitutionalFlow, sourceName: string): string {
  return `---
type: institutional_flow_snapshot
slug: institutional-flow/twse/${flow.date}/${flow.ticker}
ticker: "${flow.ticker}"
name: "${escapeYamlString(flow.name)}"
exchange: TWSE
date: ${flow.date}
source: ${sourceName}
foreign_net: ${flow.foreign_net}
trust_net: ${flow.trust_net}
dealer_net: ${flow.dealer_net}
total_net: ${flow.total_net}
net_intensity: ${flow.net_intensity ?? 0}
---

# ${flow.name} (${flow.ticker}) — 三大法人 ${flow.date}

- 外資及陸資：${fmtNet(flow.foreign_net)} 股
- 投信：${fmtNet(flow.trust_net)} 股
- 自營商：${fmtNet(flow.dealer_net)} 股
- 合計：${fmtNet(flow.total_net)} 股 (強度 ${((flow.net_intensity ?? 0) * 100).toFixed(2)}% of vol)

關聯：[[tickers/${flow.ticker}]]、[[prices/twse/${flow.date}/${flow.ticker}]]
`;
}

function renderSummary(
  all: InstitutionalFlow[],
  written: InstitutionalFlow[],
  date: string,
  sourceName: string,
): string {
  const sorted = [...all].sort((a, b) => b.total_net - a.total_net);
  const topInflow = sorted.slice(0, 10);
  const topOutflow = sorted.slice(-10).reverse();

  const fmtRow = (r: InstitutionalFlow): string =>
    `- [[tickers/${r.ticker}]] ${r.name} — 合計 ${fmtNet(r.total_net)} 股（外資 ${fmtNet(r.foreign_net)}, 投信 ${fmtNet(r.trust_net)}, 自營 ${fmtNet(r.dealer_net)}）`;

  const writtenLinks = written.map(fmtRow).join('\n');

  return `---
type: institutional_flow_summary
slug: institutional-flow/twse/${date}/_summary
date: ${date}
market: TWSE
source: ${sourceName}
---

# TWSE ${date} 三大法人 Summary

- 總筆數：${all.length}
- 寫入 watchlist 筆數：${written.length}

## Top 10 Net Inflow

${topInflow.map(fmtRow).join('\n') || '(empty)'}

## Top 10 Net Outflow

${topOutflow.map(fmtRow).join('\n') || '(empty)'}

## Watchlist Snapshots Written

${writtenLinks || '(no watchlist tickers matched today)'}
`;
}

function fmtNet(n: number): string {
  const sign = n > 0 ? '+' : '';
  return sign + n.toLocaleString();
}

function escapeYamlString(s: string): string {
  return s.replace(/"/g, '\\"');
}
