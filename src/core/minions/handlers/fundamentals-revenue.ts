/**
 * `fundamentals-revenue` job handler.
 *
 * Pulls the latest monthly revenue (月營收) for every TWSE ticker through the
 * `StockDataSource` adapter and writes one markdown snapshot per ticker under
 * `<brain_dir>/fundamentals/revenue/<YYYY-MM>/<code>.md` plus a `_summary.md`
 * ranking the strongest YoY revenue momentum.
 *
 * Freshness is the first principle (the cadence differs from price/flow): 月營收
 * is published ~10th of the FOLLOWING month, so the handler resolves the latest
 * available 年月 from the source (never assumes it matches a trading date), and
 * stamps `year_month` + `announce_date` (公告日) into every snapshot so the
 * as-of is always explicit and auditable. Stocks that haven't reported the
 * resolved month yet simply don't appear — no stale older month gets written.
 *
 * Capability-gated: only the metabase source implements `getMonthlyRevenue`.
 * Other sources cause a clean `skipped`. db_only output (regenerable from
 * metabase) — add `fundamentals/` to gbrain.yml db_only.
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MinionJobContext } from '../types.ts';
import { UnrecoverableError } from '../types.ts';
import type { MonthlyRevenue } from '../../data-sources/stock-data.ts';
import { resolveStockDataSource } from '../../data-sources/stock-data.ts';

export interface FundamentalsRevenueParams {
  brain_dir: string;
  /** 'YYYYMM'. Omit to resolve the latest available month from the source. */
  year_month?: string;
  source?: string;
}

export interface FundamentalsRevenueResult {
  status: 'ok' | 'skipped';
  reason?: string;
  year_month: string;
  source: string;
  rows_fetched: number;
  rows_written: number;
  output_dir: string;
}

export async function fundamentalsRevenueHandler(
  ctx: MinionJobContext,
): Promise<FundamentalsRevenueResult> {
  const params = validateParams(ctx.data);
  const sourceName = params.source ?? 'metabase';

  const dataSource = await resolveStockDataSource(sourceName, { brain_dir: params.brain_dir });
  if (typeof dataSource.getMonthlyRevenue !== 'function') {
    return {
      status: 'skipped',
      reason: `source "${sourceName}" has no monthly-revenue capability (use source=metabase)`,
      year_month: params.year_month ?? '',
      source: sourceName,
      rows_fetched: 0,
      rows_written: 0,
      output_dir: '',
    };
  }

  await ctx.log(
    `[fundamentals-revenue] source=${sourceName} year_month=${params.year_month ?? 'latest'}`,
  );

  const rows = await dataSource.getMonthlyRevenue('TWSE', params.year_month);
  if (rows.length === 0) {
    return {
      status: 'skipped',
      reason: `no monthly-revenue rows for ${params.year_month ?? 'latest'}`,
      year_month: params.year_month ?? '',
      source: sourceName,
      rows_fetched: 0,
      rows_written: 0,
      output_dir: '',
    };
  }

  // All rows share the resolved 年月. Folder uses YYYY-MM for readability.
  const ym = rows[0]!.year_month; // 'YYYYMM'
  const ymDir = `${ym.slice(0, 4)}-${ym.slice(4, 6)}`;
  const outputDir = join(params.brain_dir, 'fundamentals', 'revenue', ymDir);
  mkdirSync(outputDir, { recursive: true });

  let written = 0;
  for (const r of rows) {
    if (ctx.signal.aborted) throw new Error('aborted');
    const filePath = join(outputDir, `${r.ticker}.md`);
    if (existsSync(filePath)) continue; // idempotent: don't rewrite an existing month
    writeFileSync(filePath, renderRevenueMarkdown(r, ymDir, sourceName), 'utf8');
    written++;
  }

  writeFileSync(join(outputDir, '_summary.md'), renderSummary(rows, ymDir, sourceName), 'utf8');

  // _index.json: machine-readable map { code -> MonthlyRevenue } so downstream
  // generators (e.g. gen-ticker-pages.ts emitting the "財務脈動" wiki section)
  // can read the latest snapshot without parsing 1900 markdown frontmatters.
  // Always overwritten on every run — it's a regenerable summary.
  const index: Record<string, MonthlyRevenue> = {};
  for (const r of rows) index[r.ticker] = r;
  writeFileSync(
    join(outputDir, '_index.json'),
    JSON.stringify({ year_month: ym, source: sourceName, count: rows.length, by_ticker: index }, null, 0),
    'utf8',
  );

  await ctx.log(`[fundamentals-revenue] wrote ${written} snapshots + summary + index to ${outputDir}`);

  return {
    status: 'ok',
    year_month: ym,
    source: sourceName,
    rows_fetched: rows.length,
    rows_written: written,
    output_dir: outputDir,
  };
}

// ---------------------------------------------------------------------------

/** 元 → 億 (÷1e8), 2 dp. */
function yi(n: number): string {
  return (n / 1e8).toLocaleString('en-US', { maximumFractionDigits: 2 });
}
function pct(n: number): string {
  const s = n > 0 ? '+' : '';
  return `${s}${n.toFixed(2)}%`;
}

function renderRevenueMarkdown(r: MonthlyRevenue, ymDir: string, sourceName: string): string {
  return `---
type: revenue_snapshot
slug: fundamentals/revenue/${ymDir}/${r.ticker}
ticker: "${r.ticker}"
name: "${escapeYamlString(r.name)}"
exchange: TWSE
year_month: "${r.year_month}"
announce_date: ${r.announce_date}
source: ${sourceName}
revenue: ${r.revenue}
revenue_yoy_pct: ${r.yoy_pct}
revenue_mom_pct: ${r.mom_pct}
cum_yoy_pct: ${r.cum_yoy_pct}
ttm_yoy_pct: ${r.ttm_yoy_pct}
---

# ${r.name} (${r.ticker}) — 月營收 ${ymDir}

- 單月合併營收 **${yi(r.revenue)} 億**（YoY ${pct(r.yoy_pct)}、MoM ${pct(r.mom_pct)}）
- 累計(YTD) ${yi(r.cum_revenue)} 億（YoY ${pct(r.cum_yoy_pct)}）
- 近12月(TTM) ${yi(r.ttm_revenue)} 億（YoY ${pct(r.ttm_yoy_pct)}）
- 近三月年增 ${pct(r.three_month_yoy_pct)}
- 公告日 ${r.announce_date}

> 月頻基本面（公告日為資料時間點，與日頻量價/法人不同步）。

關聯：[[tickers/${r.ticker}]]
`;
}

function renderSummary(rows: MonthlyRevenue[], ymDir: string, sourceName: string): string {
  const byYoy = [...rows].sort((a, b) => b.yoy_pct - a.yoy_pct);
  const topUp = byYoy.slice(0, 15);
  const topDown = byYoy.slice(-15).reverse();
  const fmt = (r: MonthlyRevenue): string =>
    `- [[tickers/${r.ticker}]] ${r.name} — 單月 ${yi(r.revenue)} 億，YoY ${pct(r.yoy_pct)}（MoM ${pct(r.mom_pct)}）`;

  return `---
type: revenue_summary
slug: fundamentals/revenue/${ymDir}/_summary
year_month: "${rows[0]!.year_month}"
market: TWSE
source: ${sourceName}
---

# TWSE ${ymDir} 月營收 Summary

- 回報檔數：${rows.length}
- 資料時間點：${ymDir}（公告日約次月 10 日起；個股公告日見各快照）

## 單月營收 YoY 成長 Top 15

${topUp.map(fmt).join('\n') || '(empty)'}

## 單月營收 YoY 衰退 Top 15

${topDown.map(fmt).join('\n') || '(empty)'}
`;
}

// ---------------------------------------------------------------------------

function validateParams(data: Record<string, unknown>): FundamentalsRevenueParams {
  if (typeof data.brain_dir !== 'string' || !data.brain_dir) {
    throw new UnrecoverableError('fundamentals-revenue: missing required param "brain_dir"');
  }
  if (data.year_month !== undefined) {
    if (typeof data.year_month !== 'string' || !/^\d{6}$/.test(data.year_month)) {
      throw new UnrecoverableError('fundamentals-revenue: "year_month" must be "YYYYMM"');
    }
  }
  if (data.source !== undefined && typeof data.source !== 'string') {
    throw new UnrecoverableError('fundamentals-revenue: "source" must be a string');
  }
  return {
    brain_dir: data.brain_dir,
    year_month: data.year_month as string | undefined,
    source: data.source as string | undefined,
  };
}

function escapeYamlString(s: string): string {
  return s.replace(/"/g, '\\"');
}
