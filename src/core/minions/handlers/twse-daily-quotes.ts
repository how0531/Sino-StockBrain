/**
 * `twse-daily-quotes` job handler.
 *
 * Pulls daily OHLCV for every TWSE-listed stock from the free TWSE Open API,
 * filters to the operator's watchlist (the tickers/ directory), and writes
 * one markdown snapshot per ticker under
 * `<brain_dir>/prices/twse/<YYYY-MM-DD>/<code>.md` plus a `_summary.md`.
 *
 * Why a handler instead of a shell cron:
 *   - Stall detection + automatic retry on transient HTTP failures
 *   - Idempotency-key dedup (`twse-daily-quotes:<YYYY-MM-DD>`)
 *   - Wires into `gbrain jobs list` / `--follow` for observability
 *
 * What this handler does NOT do (kept intentionally narrow):
 *   - No DB writes. Output goes to disk; `gbrain sync` ingests it next pass.
 *   - No anomaly detection. That's the dream cycle's job (find_anomalies +
 *     market-heat phase, both pure functions over the snapshots written here).
 *   - No call to LLMs. Deterministic data pull only.
 *
 * Trust model: this is a sense-layer recipe handler. It only HTTP-GETs
 * a public endpoint and writes inside `brain_dir`. Job submission is
 * NOT in PROTECTED_JOB_NAMES — fine for any caller, no RCE surface.
 */

import { mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MinionJobContext } from '../types.ts';
import { UnrecoverableError } from '../types.ts';

/** TWSE Open API — daily summary of every listed stock. Free, no auth. */
const TWSE_STOCK_DAY_ALL_URL =
  'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL';

/** Max time we wait for the TWSE response before failing the attempt.
 *  Endpoint usually responds <2s; 15s is comfortable headroom. */
const FETCH_TIMEOUT_MS = 15_000;

export interface TwseDailyQuotesParams {
  /** Brain repo absolute path. REQUIRED. */
  brain_dir: string;
  /** Target trading day. Accepts 'today' or 'YYYY-MM-DD'. Default 'today'. */
  date?: string;
  /** When true, only write snapshots for tickers that already have a
   *  `tickers/<code>.md` page (i.e. the operator's watchlist). Default true. */
  watchlist_only?: boolean;
  /** Override URL for tests. */
  source_url?: string;
}

/** What TWSE Open API returns (one entry per listed stock).
 *  Endpoint is documented at https://openapi.twse.com.tw/. */
interface TwseQuoteRow {
  Code: string;          // 證券代號 (e.g. "2330")
  Name: string;          // 證券名稱 (中文)
  TradeVolume: string;   // 成交股數
  TradeValue: string;    // 成交金額 (元)
  OpeningPrice: string;
  HighestPrice: string;
  LowestPrice: string;
  ClosingPrice: string;
  Change: string;        // 漲跌價差 (帶 +/- 符號)
  Transaction: string;   // 成交筆數
}

export interface TwseDailyQuotesResult {
  status: 'ok' | 'skipped';
  reason?: string;
  date: string;
  rows_fetched: number;
  rows_written: number;
  output_dir: string;
}

export async function twseDailyQuotesHandler(
  ctx: MinionJobContext,
): Promise<TwseDailyQuotesResult> {
  const params = validateParams(ctx.data);
  const targetDate = resolveDate(params.date ?? 'today');

  // Weekend short-circuit. Cheap to detect, avoids burning the rate-limit
  // budget on days TWSE returns yesterday's data.
  const dow = new Date(targetDate + 'T08:00:00+08:00').getUTCDay();
  if (dow === 0 || dow === 6) {
    return {
      status: 'skipped',
      reason: 'non-trading day (weekend)',
      date: targetDate,
      rows_fetched: 0,
      rows_written: 0,
      output_dir: '',
    };
  }

  const outputDir = join(params.brain_dir, 'prices', 'twse', targetDate);
  mkdirSync(outputDir, { recursive: true });

  const watchlist = params.watchlist_only !== false
    ? loadWatchlist(params.brain_dir)
    : null;

  await ctx.log(
    `[twse-daily-quotes] fetching ${TWSE_STOCK_DAY_ALL_URL} for ${targetDate}` +
    (watchlist ? ` (watchlist=${watchlist.size} tickers)` : ' (all)'),
  );

  const rows = await fetchQuotes(params.source_url ?? TWSE_STOCK_DAY_ALL_URL, ctx.signal);

  let written = 0;
  const writtenRows: TwseQuoteRow[] = [];
  for (const row of rows) {
    if (ctx.signal.aborted) throw new Error('aborted');
    if (watchlist && !watchlist.has(row.Code)) continue;

    const filePath = join(outputDir, `${row.Code}.md`);
    // Skip-if-exists is the cheap idempotency layer for resumes mid-run.
    // The job-level idempotency_key handles whole-day re-submits.
    if (existsSync(filePath)) continue;

    writeFileSync(filePath, renderQuoteMarkdown(row, targetDate), 'utf8');
    writtenRows.push(row);
    written++;
  }

  // Always rewrite summary so re-runs reflect the full current state.
  const summaryPath = join(outputDir, '_summary.md');
  writeFileSync(summaryPath, renderSummary(rows, writtenRows, targetDate), 'utf8');

  await ctx.log(
    `[twse-daily-quotes] wrote ${written} ticker snapshots + summary to ${outputDir}`,
  );

  return {
    status: 'ok',
    date: targetDate,
    rows_fetched: rows.length,
    rows_written: written,
    output_dir: outputDir,
  };
}

// ---------------------------------------------------------------------------
// helpers (kept private to this handler)
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
  if (data.source_url !== undefined && typeof data.source_url !== 'string') {
    throw new UnrecoverableError('twse-daily-quotes: "source_url" must be a string');
  }
  // Explicit construction beats a wide cast — every field is type-checked above,
  // so this also serves as a structural contract test.
  return {
    brain_dir: data.brain_dir,
    date: data.date as string | undefined,
    watchlist_only: data.watchlist_only as boolean | undefined,
    source_url: data.source_url as string | undefined,
  };
}

function resolveDate(input: string): string {
  if (input === 'today') {
    // Use Asia/Taipei date — TWSE is a Taipei market.
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

/** Walk tickers/ for `<CODE>.md` files. Returns the set of CODE strings.
 *  Skips the `_template.md` placeholder and any non-md files. */
function loadWatchlist(brainDir: string): Set<string> {
  const tickersDir = join(brainDir, 'tickers');
  if (!existsSync(tickersDir)) return new Set();
  const codes = new Set<string>();
  for (const name of readdirSync(tickersDir)) {
    if (!name.endsWith('.md')) continue;
    if (name.startsWith('_')) continue;
    const code = name.replace(/\.md$/, '');
    // TWSE codes are numeric (4 digits typically). US tickers are
    // alphabetic and won't match here — fine, watchlist filter is
    // strictly per-exchange.
    if (/^\d{3,6}$/.test(code)) codes.add(code);
  }
  return codes;
}

async function fetchQuotes(url: string, signal: AbortSignal): Promise<TwseQuoteRow[]> {
  // Compose timeout with the job-level abort.
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(new Error('timeout')), FETCH_TIMEOUT_MS);
  const onJobAbort = () => timeoutCtrl.abort(signal.reason);
  signal.addEventListener('abort', onJobAbort, { once: true });

  try {
    const res = await fetch(url, { signal: timeoutCtrl.signal });
    if (!res.ok) {
      throw new Error(`TWSE Open API returned HTTP ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as unknown;
    if (!Array.isArray(json)) {
      throw new Error('TWSE Open API: expected JSON array, got ' + typeof json);
    }
    return json as TwseQuoteRow[];
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onJobAbort);
  }
}

function renderQuoteMarkdown(row: TwseQuoteRow, date: string): string {
  const close = parseFloat(row.ClosingPrice);
  const open = parseFloat(row.OpeningPrice);
  const changePct = open > 0 ? ((close - open) / open) * 100 : 0;
  const tickerLink = `[[tickers/${row.Code}]]`;
  // Frontmatter uses YAML-safe numeric strings (NaN → null).
  const num = (s: string): string => {
    const n = parseFloat(s);
    return Number.isFinite(n) ? String(n) : 'null';
  };
  return `---
type: price_snapshot
slug: prices/twse/${date}/${row.Code}
ticker: "${row.Code}"
name: "${escapeYamlString(row.Name)}"
exchange: TWSE
date: ${date}
source: twse-openapi
ohlcv:
  open: ${num(row.OpeningPrice)}
  high: ${num(row.HighestPrice)}
  low: ${num(row.LowestPrice)}
  close: ${num(row.ClosingPrice)}
  volume: ${num(row.TradeVolume)}
  trades: ${num(row.Transaction)}
  turnover: ${num(row.TradeValue)}
change_pct: ${changePct.toFixed(2)}
---

# ${row.Name} (${row.Code}) — ${date}

收盤 **${row.ClosingPrice}** TWD（漲跌 ${row.Change}，當日 ${changePct.toFixed(2)}%）。
成交量 ${row.TradeVolume} 股 / ${row.Transaction} 筆。

關聯：${tickerLink}
`;
}

function renderSummary(
  all: TwseQuoteRow[],
  written: TwseQuoteRow[],
  date: string,
): string {
  const up = all.filter((r) => parseFloat(r.Change) > 0).length;
  const down = all.filter((r) => parseFloat(r.Change) < 0).length;
  const flat = all.length - up - down;
  const totalTurnover = all.reduce((s, r) => s + (parseFloat(r.TradeValue) || 0), 0);
  // 成交量 top 20 in absolute volume terms.
  const top = [...all]
    .filter((r) => parseFloat(r.TradeVolume) > 0)
    .sort((a, b) => parseFloat(b.TradeVolume) - parseFloat(a.TradeVolume))
    .slice(0, 20);

  const topLines = top
    .map((r) => `- ${r.Name} (${r.Code}) — vol=${r.TradeVolume}, close=${r.ClosingPrice}, chg=${r.Change}`)
    .join('\n');

  const writtenLinks = written
    .map((r) => `- [[tickers/${r.Code}]] ${r.Name} — close ${r.ClosingPrice}, chg ${r.Change}`)
    .join('\n');

  return `---
type: market_summary
slug: prices/twse/${date}/_summary
date: ${date}
market: TWSE
source: twse-openapi
---

# TWSE ${date} Daily Summary

- 漲跌家數：${up} 漲 / ${down} 跌 / ${flat} 平盤
- 總成交金額：${(totalTurnover / 1e8).toFixed(2)} 億 TWD
- API 回傳筆數：${all.length}
- 寫入 watchlist 筆數：${written.length}

## Top 20 by Volume

${topLines || '(empty)'}

## Watchlist Snapshots Written

${writtenLinks || '(no watchlist tickers matched today)'}
`;
}

function escapeYamlString(s: string): string {
  return s.replace(/"/g, '\\"');
}
