/**
 * `movers-detect` job handler — Phase E step 1 (attribution layer entry point).
 *
 * For a given trading day, picks the day's notable movers from the full TWSE
 * universe via the StockDataSource (single call to `getDailySnapshot`, no
 * per-file disk reads) and writes:
 *
 *   <brain_dir>/movers/<YYYY-MM-DD>.json   structured rankings (chatbot reads)
 *   <brain_dir>/movers/<YYYY-MM-DD>.md     human summary
 *
 * Three rankings (independent — same ticker can appear in multiple):
 *   - top_gainers    Top N by change_pct (highest %)
 *   - top_losers     Top N by change_pct (lowest, i.e. most negative)
 *   - top_turnover   Top N by turnover (TWD traded) — liquid heavyweights
 *
 * Filtering: only 4-digit common-stock codes (`^\d{4}$`) — drops warrants,
 * 特別股, ETF subclasses that share the same snapshot table. We DON'T drop
 * 漲跌停 — they ARE movers, even if their % is capped.
 *
 * No volume_intensity in v1: would require 20-day historical pull per ticker
 * (~40k file reads or a heavier SQL). Step 1b will add it; v1 ships with
 * turnover as the proxy for "anyone actually traded this name".
 *
 * Idempotent: always overwrites `<date>.json` and `<date>.md` (latest run wins).
 * No skip-if-exists — the latest snapshot is always the truth.
 *
 * Capability-gated source: only metabase implements `getDailySnapshot` for
 * real data. Mock works too but produces deterministic noise.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MinionJobContext } from '../types.ts';
import { UnrecoverableError } from '../types.ts';
import type { DailyQuote } from '../../data-sources/stock-data.ts';
import { resolveStockDataSource } from '../../data-sources/stock-data.ts';

const DEFAULT_TOP_N = 30;

export interface MoversDetectParams {
  brain_dir: string;
  /** 'YYYY-MM-DD'. Omit to resolve the latest available trading day. */
  date?: string;
  source?: string;
  top_n?: number;
}

export interface MoversDetectResult {
  status: 'ok' | 'skipped';
  reason?: string;
  date: string;
  source: string;
  universe_size: number;
  top_n: number;
  output_path: string;
}

interface Mover {
  ticker: string;
  name: string;
  close: number;
  change_pct: number;
  volume: number;
  turnover: number;
}

export async function moversDetectHandler(
  ctx: MinionJobContext,
): Promise<MoversDetectResult> {
  const params = validateParams(ctx.data);
  const sourceName = params.source ?? 'metabase';
  const topN = params.top_n ?? DEFAULT_TOP_N;

  const dataSource = await resolveStockDataSource(sourceName, { brain_dir: params.brain_dir });

  // Resolve target date — explicit > latest-from-source > error.
  let date = params.date;
  if (!date) {
    if (typeof dataSource.getLatestQuoteDate !== 'function') {
      throw new UnrecoverableError(
        `movers-detect: source "${sourceName}" cannot resolve latest date; pass "date":"YYYY-MM-DD" explicitly`,
      );
    }
    const latest = await dataSource.getLatestQuoteDate('TWSE');
    if (!latest) {
      return {
        status: 'skipped', reason: 'no quote dates available from source',
        date: '', source: sourceName, universe_size: 0, top_n: topN, output_path: '',
      };
    }
    date = latest;
  }

  await ctx.log(`[movers-detect] source=${sourceName} date=${date} top_n=${topN}`);

  const snap = await dataSource.getDailySnapshot('TWSE', date);
  if (snap.quotes.length === 0) {
    return {
      status: 'skipped', reason: `no quotes for ${date} (non-trading day or empty snapshot)`,
      date, source: sourceName, universe_size: 0, top_n: topN, output_path: '',
    };
  }

  // Common stock only — 4-digit numeric codes.
  const eligible = snap.quotes.filter((q) => /^\d{4}$/.test(q.ticker));

  const movers: Mover[] = eligible.map((q) => ({
    ticker: q.ticker, name: q.name, close: q.close,
    change_pct: q.change_pct, volume: q.volume, turnover: q.turnover,
  }));

  const byGain = [...movers].sort((a, b) => b.change_pct - a.change_pct).slice(0, topN);
  const byLoss = [...movers].sort((a, b) => a.change_pct - b.change_pct).slice(0, topN);
  const byTurnover = [...movers].sort((a, b) => b.turnover - a.turnover).slice(0, topN);

  const outDir = join(params.brain_dir, 'movers');
  mkdirSync(outDir, { recursive: true });

  const jsonPath = join(outDir, `${date}.json`);
  writeFileSync(
    jsonPath,
    JSON.stringify({
      date, source: sourceName, top_n: topN, universe_size: eligible.length,
      top_gainers: byGain, top_losers: byLoss, top_turnover: byTurnover,
    }, null, 0),
    'utf8',
  );
  const mdPath = join(outDir, `${date}.md`);
  writeFileSync(mdPath, renderMarkdown(date, sourceName, eligible.length, topN, byGain, byLoss, byTurnover), 'utf8');

  await ctx.log(`[movers-detect] universe=${eligible.length}, top_n=${topN}, wrote ${jsonPath} + .md`);

  return {
    status: 'ok', date, source: sourceName,
    universe_size: eligible.length, top_n: topN, output_path: jsonPath,
  };
}

// ---------------------------------------------------------------------------

function fmtPct(p: number): string {
  const s = p > 0 ? '+' : '';
  return `${s}${p.toFixed(2)}%`;
}
function fmtTurnover(t: number): string {
  // 元 → 億
  const yi = t / 1e8;
  if (yi >= 100) return `${Math.round(yi).toLocaleString('en')} 億`;
  return `${yi.toFixed(1)} 億`;
}

function row(m: Mover): string {
  return `- [[tickers/${m.ticker}]] ${m.name} — 收 ${m.close} (**${fmtPct(m.change_pct)}**)，成交 ${fmtTurnover(m.turnover)}`;
}

function renderMarkdown(
  date: string, source: string, universe: number, topN: number,
  gain: Mover[], loss: Mover[], turnover: Mover[],
): string {
  return `---
type: movers_snapshot
slug: movers/${date}
date: ${date}
source: ${source}
universe_size: ${universe}
top_n: ${topN}
---

# TWSE ${date} 個股動能 (Top ${topN})

- 對象：4 碼一般股票，共 ${universe} 檔
- 排序：漲幅 / 跌幅 / 成交金額 三軸獨立

## 漲幅 Top ${topN}

${gain.map(row).join('\n') || '(empty)'}

## 跌幅 Top ${topN}

${loss.map(row).join('\n') || '(empty)'}

## 成交金額 Top ${topN}

${turnover.map(row).join('\n') || '(empty)'}
`;
}

// ---------------------------------------------------------------------------

function validateParams(data: Record<string, unknown>): MoversDetectParams {
  if (typeof data.brain_dir !== 'string' || !data.brain_dir) {
    throw new UnrecoverableError('movers-detect: missing required param "brain_dir"');
  }
  if (data.date !== undefined) {
    if (typeof data.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
      throw new UnrecoverableError('movers-detect: "date" must be "YYYY-MM-DD"');
    }
  }
  if (data.source !== undefined && typeof data.source !== 'string') {
    throw new UnrecoverableError('movers-detect: "source" must be a string');
  }
  if (data.top_n !== undefined) {
    if (typeof data.top_n !== 'number' || !Number.isInteger(data.top_n) || data.top_n < 1) {
      throw new UnrecoverableError('movers-detect: "top_n" must be a positive integer');
    }
  }
  return {
    brain_dir: data.brain_dir,
    date: data.date as string | undefined,
    source: data.source as string | undefined,
    top_n: data.top_n as number | undefined,
  };
}
