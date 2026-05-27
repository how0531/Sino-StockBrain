/**
 * `fundamentals-eps` job handler.
 *
 * Pulls the latest **analyst-consensus EPS snapshot** (current-year + next-year
 * forecast + TTM actual) for every TWSE/TPEX ticker through the
 * `StockDataSource` adapter, and writes one markdown snapshot per ticker under
 * `<brain_dir>/fundamentals/eps/<YYYY-MM>/<code>.md` plus a `_summary.md`
 * (top 15 next-year EPS growth) and a `_index.json` (machine-readable map).
 *
 * Cadence: cmoney's `月機構預估盈餘與EPS` is a monthly snapshot rolled up from
 * broker reports — distinct from monthly revenue (公告日 ~10th of next month).
 * Handler always resolves the latest available `年月` from the source unless
 * the caller pins one with `year_month: "YYYYMM"`.
 *
 * Confidence gating: the summary's Top-N lists filter to tickers with at least
 * `MIN_ANALYSTS_FOR_TOP` brokers — a 1-analyst forecast isn't a "consensus" and
 * would otherwise dominate growth rankings (lone broker with optimistic call).
 *
 * Capability-gated: only the `metabase` source implements `getConsensusEPS`.
 * Other sources → clean `skipped`. db_only output (regenerable from cmoney).
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MinionJobContext } from '../types.ts';
import { UnrecoverableError } from '../types.ts';
import type { ConsensusEPS } from '../../data-sources/stock-data.ts';
import { resolveStockDataSource } from '../../data-sources/stock-data.ts';

const MIN_ANALYSTS_FOR_TOP = 3; // gate Top-N lists vs lone-analyst noise

export interface FundamentalsEPSParams {
  brain_dir: string;
  year_month?: string;
  source?: string;
}

export interface FundamentalsEPSResult {
  status: 'ok' | 'skipped';
  reason?: string;
  year_month: string;
  source: string;
  rows_fetched: number;
  rows_written: number;
  output_dir: string;
}

export async function fundamentalsEPSHandler(
  ctx: MinionJobContext,
): Promise<FundamentalsEPSResult> {
  const params = validateParams(ctx.data);
  const sourceName = params.source ?? 'metabase';

  const dataSource = await resolveStockDataSource(sourceName, { brain_dir: params.brain_dir });
  if (typeof dataSource.getConsensusEPS !== 'function') {
    return {
      status: 'skipped',
      reason: `source "${sourceName}" has no consensus-EPS capability (use source=metabase)`,
      year_month: params.year_month ?? '',
      source: sourceName,
      rows_fetched: 0,
      rows_written: 0,
      output_dir: '',
    };
  }

  await ctx.log(`[fundamentals-eps] source=${sourceName} year_month=${params.year_month ?? 'latest'}`);

  const rows = await dataSource.getConsensusEPS('TWSE', params.year_month);
  if (rows.length === 0) {
    return {
      status: 'skipped',
      reason: `no consensus-EPS rows for ${params.year_month ?? 'latest'}`,
      year_month: params.year_month ?? '',
      source: sourceName,
      rows_fetched: 0,
      rows_written: 0,
      output_dir: '',
    };
  }

  const ym = rows[0]!.year_month; // 'YYYYMM'
  const ymDir = `${ym.slice(0, 4)}-${ym.slice(4, 6)}`;
  const outputDir = join(params.brain_dir, 'fundamentals', 'eps', ymDir);
  mkdirSync(outputDir, { recursive: true });

  let written = 0;
  for (const r of rows) {
    if (ctx.signal.aborted) throw new Error('aborted');
    const filePath = join(outputDir, `${r.ticker}.md`);
    if (existsSync(filePath)) continue;
    writeFileSync(filePath, renderEPSMarkdown(r, ymDir, sourceName), 'utf8');
    written++;
  }

  writeFileSync(join(outputDir, '_summary.md'), renderSummary(rows, ymDir, sourceName), 'utf8');

  const index: Record<string, ConsensusEPS> = {};
  for (const r of rows) index[r.ticker] = r;
  writeFileSync(
    join(outputDir, '_index.json'),
    JSON.stringify({ year_month: ym, source: sourceName, count: rows.length, by_ticker: index }, null, 0),
    'utf8',
  );

  await ctx.log(`[fundamentals-eps] wrote ${written} snapshots + summary + index to ${outputDir}`);

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

function eps(n: number | null): string { return n == null ? '—' : n.toFixed(2); }
function pct(n: number | null): string {
  if (n == null) return '—';
  const s = n > 0 ? '+' : '';
  return `${s}${n.toFixed(1)}%`;
}
function pe(n: number | null): string { return n == null ? '—' : `${n.toFixed(1)}x`; }

function renderEPSMarkdown(r: ConsensusEPS, ymDir: string, sourceName: string): string {
  return `---
type: eps_snapshot
slug: fundamentals/eps/${ymDir}/${r.ticker}
ticker: "${r.ticker}"
name: "${escapeYamlString(r.name)}"
exchange: TWSE
year_month: "${r.year_month}"
updated_date: ${r.updated_date}
source: ${sourceName}
ttm_eps: ${r.ttm_eps ?? 'null'}
current_year_eps: ${r.current_year_eps ?? 'null'}
next_year_eps: ${r.next_year_eps ?? 'null'}
current_year_growth_pct: ${r.current_year_growth_pct ?? 'null'}
next_year_growth_pct: ${r.next_year_growth_pct ?? 'null'}
analyst_count: ${r.analyst_count ?? 'null'}
analyst_count_next: ${r.analyst_count_next ?? 'null'}
pe_low: ${r.pe_low ?? 'null'}
pe_high: ${r.pe_high ?? 'null'}
---

# ${r.name} (${r.ticker}) — 機構 EPS 預估 ${ymDir}

- 累計近四季 EPS（TTM 實際）：**${eps(r.ttm_eps)} 元**
- 今年機構估稅後 EPS：**${eps(r.current_year_eps)} 元**（成長 ${pct(r.current_year_growth_pct)}，${r.analyst_count ?? 0} 家機構覆蓋）
- 明年機構估稅後 EPS：**${eps(r.next_year_eps)} 元**（成長 ${pct(r.next_year_growth_pct)}，${r.analyst_count_next ?? 0} 家機構覆蓋）
- 本益比區間：${pe(r.pe_low)} – ${pe(r.pe_high)}
- 最後更新：${r.updated_date}

> 月頻機構預估 snapshot（cmoney"月機構預估盈餘與EPS"），覆蓋機構數 < 3 時為單一機構觀點。

關聯：[[tickers/${r.ticker}]]
`;
}

function renderSummary(rows: ConsensusEPS[], ymDir: string, sourceName: string): string {
  const ranked = rows.filter(
    (r) => r.next_year_growth_pct != null && (r.analyst_count_next ?? 0) >= MIN_ANALYSTS_FOR_TOP,
  );
  const byNext = [...ranked].sort((a, b) => b.next_year_growth_pct! - a.next_year_growth_pct!);
  const topUpNext = byNext.slice(0, 15);
  const topDownNext = byNext.slice(-15).reverse();

  const rankedCY = rows.filter(
    (r) => r.current_year_growth_pct != null && (r.analyst_count ?? 0) >= MIN_ANALYSTS_FOR_TOP,
  );
  const byCY = [...rankedCY].sort((a, b) => b.current_year_growth_pct! - a.current_year_growth_pct!);
  const topUpCY = byCY.slice(0, 15);

  const fmtNext = (r: ConsensusEPS): string =>
    `- [[tickers/${r.ticker}]] ${r.name} — 今年估 ${eps(r.current_year_eps)} → 明年估 **${eps(r.next_year_eps)}** 元（成長 ${pct(r.next_year_growth_pct)}，${r.analyst_count_next} 家機構）`;
  const fmtCY = (r: ConsensusEPS): string =>
    `- [[tickers/${r.ticker}]] ${r.name} — 今年估 **${eps(r.current_year_eps)}** 元（成長 ${pct(r.current_year_growth_pct)}，TTM ${eps(r.ttm_eps)}，${r.analyst_count} 家機構）`;

  return `---
type: eps_summary
slug: fundamentals/eps/${ymDir}/_summary
year_month: "${rows[0]!.year_month}"
market: TWSE
source: ${sourceName}
min_analysts_for_top: ${MIN_ANALYSTS_FOR_TOP}
---

# TWSE ${ymDir} 機構 EPS 預估 Summary

- 回報檔數：${rows.length}
- Top-N 過濾門檻：機構覆蓋 ≥ ${MIN_ANALYSTS_FOR_TOP} 家
- 資料時間點：${ymDir}（cmoney 月度 snapshot；個股最後更新日見各快照）

## 明年預估 EPS 成長 Top 15

${topUpNext.map(fmtNext).join('\n') || '(empty)'}

## 明年預估 EPS 成長 Bottom 15

${topDownNext.map(fmtNext).join('\n') || '(empty)'}

## 今年預估 EPS 成長 Top 15

${topUpCY.map(fmtCY).join('\n') || '(empty)'}
`;
}

// ---------------------------------------------------------------------------

function validateParams(data: Record<string, unknown>): FundamentalsEPSParams {
  if (typeof data.brain_dir !== 'string' || !data.brain_dir) {
    throw new UnrecoverableError('fundamentals-eps: missing required param "brain_dir"');
  }
  if (data.year_month !== undefined) {
    if (typeof data.year_month !== 'string' || !/^\d{6}$/.test(data.year_month)) {
      throw new UnrecoverableError('fundamentals-eps: "year_month" must be "YYYYMM"');
    }
  }
  if (data.source !== undefined && typeof data.source !== 'string') {
    throw new UnrecoverableError('fundamentals-eps: "source" must be a string');
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
