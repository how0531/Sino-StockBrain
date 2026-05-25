/**
 * `market-heat` job handler.
 *
 * Composes today's three signal streams (量價 / 法人 / 新聞密度) into a single
 * heat_score per ticker per day. Reads from disk artifacts the other three
 * recipe handlers wrote earlier in the day, calls the pure compute in
 * `core/heat-score/compute.ts`, writes a ranked markdown report to
 * `<brain_dir>/playbooks/heat/<YYYY-MM-DD>.md`.
 *
 * Why a Minion handler (not a cycle phase yet):
 *   - The cycle-phase infrastructure (BaseCyclePhase, source-scope threading,
 *     dream cycle locking) is heavier than what this needs.
 *   - A handler can be cron-driven OR triggered manually as part of a
 *     `daily-market-digest` skill flow.
 *   - Promotion path is clean: when we want this to ride inside `gbrain dream`,
 *     wrap the same compute call inside a phase class.
 *
 * Trust model: NOT in PROTECTED_JOB_NAMES — no LLM cost, no RCE. Pure disk
 * read + disk write inside brain_dir.
 *
 * Dependencies:
 *   - <brain_dir>/prices/twse/<date>/*.md            (from twse-daily-quotes)
 *   - <brain_dir>/institutional-flow/twse/<date>/*.md (from twse-institutional-flow)
 *   - <brain_dir>/news/<date>/_summary.md             (from news-ingest)
 *
 * If any one of these is missing, the handler degrades gracefully: the
 * missing signal contributes 0. Operators see this in the per-row rationale.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MinionJobContext } from '../types.ts';
import { UnrecoverableError } from '../types.ts';
import {
  computeHeatScore,
  DEFAULT_WEIGHTS,
  rankByHeat,
  type DailyHeatInputs,
  type HeatScoreOutput,
  type HeatWeights,
} from '../../heat-score/compute.ts';

/** Volume history lookback (calendar days). Real trading-day count is less;
 *  the handler walks back day-by-day until it has up to this many points. */
const VOLUME_HISTORY_DAYS = 30;

export interface MarketHeatParams {
  brain_dir: string;
  date?: string;
  /** Override the default weights. Partial overrides merge with defaults. */
  weights?: Partial<HeatWeights>;
}

export interface MarketHeatResult {
  status: 'ok' | 'skipped';
  reason?: string;
  date: string;
  tickers_scored: number;
  output_path: string;
  signals_available: {
    prices: boolean;
    institutional_flow: boolean;
    news: boolean;
  };
  weights_used: HeatWeights;
}

export async function marketHeatHandler(
  ctx: MinionJobContext,
): Promise<MarketHeatResult> {
  const params = validateParams(ctx.data);
  const date = resolveDate(params.date ?? 'today');

  const weights: HeatWeights = { ...DEFAULT_WEIGHTS, ...(params.weights ?? {}) };

  const pricesDir = join(params.brain_dir, 'prices', 'twse', date);
  const flowDir = join(params.brain_dir, 'institutional-flow', 'twse', date);
  const newsSummary = join(params.brain_dir, 'news', date, '_summary.md');

  const signalsAvailable = {
    prices: existsSync(pricesDir),
    institutional_flow: existsSync(flowDir),
    news: existsSync(newsSummary),
  };

  await ctx.log(
    `[market-heat] date=${date} signals=` +
      JSON.stringify(signalsAvailable),
  );

  if (!signalsAvailable.prices) {
    return {
      status: 'skipped',
      reason: `no prices snapshot at ${pricesDir}; run twse-daily-quotes first`,
      date,
      tickers_scored: 0,
      output_path: '',
      signals_available: signalsAvailable,
      weights_used: weights,
    };
  }

  const todayPrices = readPriceSnapshots(pricesDir);
  const todayFlow = signalsAvailable.institutional_flow
    ? readFlowSnapshots(flowDir)
    : new Map<string, number>();
  const newsMentions = signalsAvailable.news
    ? readNewsMentions(newsSummary)
    : new Map<string, number>();

  // Build per-ticker volume history by walking previous days' price dirs.
  const history = buildVolumeHistory(params.brain_dir, date, todayPrices, ctx);

  // Liquidity floor: skip thinly-traded names. An illiquid small-cap whose 外資
  // net is a large fraction of a tiny day-volume otherwise pins the
  // institutional component at 100 and crowds the board with names no desk
  // watches. NT$100M (1億) daily turnover ≈ the liquid universe. Tunable; a
  // future calibration pass can lift it into config.
  const LIQUIDITY_FLOOR_TWD = 100_000_000;
  const scored: HeatScoreOutput[] = [];
  for (const [ticker, priceSnapshot] of todayPrices) {
    if (ctx.signal.aborted) throw new Error('aborted');
    if (priceSnapshot.close * priceSnapshot.volume < LIQUIDITY_FLOOR_TWD) continue;
    const inputs: DailyHeatInputs = {
      ticker,
      close: priceSnapshot.close,
      change_pct: priceSnapshot.change_pct,
      volume: priceSnapshot.volume,
      net_intensity: todayFlow.get(ticker),
      mention_count: newsMentions.get(ticker),
      volume_history: history.get(ticker) ?? [],
    };
    scored.push(computeHeatScore(inputs, weights));
  }

  const ranked = rankByHeat(scored);

  const outputDir = join(params.brain_dir, 'playbooks', 'heat');
  mkdirSync(outputDir, { recursive: true });
  const outputPath = join(outputDir, `${date}.md`);
  writeFileSync(outputPath, renderHeatReport(date, ranked, weights, signalsAvailable), 'utf8');

  await ctx.log(
    `[market-heat] scored ${ranked.length} tickers, wrote ${outputPath}`,
  );

  return {
    status: 'ok',
    date,
    tickers_scored: ranked.length,
    output_path: outputPath,
    signals_available: signalsAvailable,
    weights_used: weights,
  };
}

// ===========================================================================
// disk readers (kept narrow — only the fields the compute needs)
// ===========================================================================

interface PriceRow {
  ticker: string;
  name: string;
  close: number;
  change_pct: number;
  volume: number;
}

/** Read all per-ticker price snapshots in a day dir, skipping _summary.md. */
function readPriceSnapshots(dir: string): Map<string, PriceRow> {
  const out = new Map<string, PriceRow>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    if (name.startsWith('_')) continue;
    const ticker = name.replace(/\.md$/, '');
    const raw = readFileSync(join(dir, name), 'utf8');
    const fm = parseFrontmatter(raw);
    if (!fm) continue;
    out.set(ticker, {
      ticker,
      name: stripQuotes(fm.get('name') ?? ticker),
      close: parseFloat(fm.get('ohlcv.close') ?? '0') || 0,
      change_pct: parseFloat(fm.get('change_pct') ?? '0') || 0,
      volume: parseFloat(fm.get('ohlcv.volume') ?? '0') || 0,
    });
  }
  return out;
}

/** Read net_intensity from each institutional-flow snapshot. */
function readFlowSnapshots(dir: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    if (name.startsWith('_')) continue;
    const ticker = name.replace(/\.md$/, '');
    const raw = readFileSync(join(dir, name), 'utf8');
    const fm = parseFrontmatter(raw);
    if (!fm) continue;
    const ni = parseFloat(fm.get('net_intensity') ?? '0');
    if (Number.isFinite(ni)) out.set(ticker, ni);
  }
  return out;
}

/** Read news summary frontmatter and extract ticker mention counts from the
 *  "## Top 提及個股" section body. The news-ingest writer formats them as
 *  `- [[tickers/2327]] — 提及 3 次`. */
function readNewsMentions(summaryPath: string): Map<string, number> {
  const out = new Map<string, number>();
  const raw = readFileSync(summaryPath, 'utf8');
  // Tolerant of every _summary format the news-ingest writer has shipped:
  // `[[tickers/X]]`, bare `tickers/X`, and bare code `X` (the edge-free form).
  // The "— 提及 N 次" suffix is what disambiguates a mention line from an
  // article line, so the leading code shape can stay loose.
  const re = /^-\s*(?:\[\[)?(?:tickers\/)?([A-Za-z0-9]+)(?:\]\])?\s*—\s*提及\s*(\d+)\s*次/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const ticker = m[1]!;
    const count = parseInt(m[2]!, 10);
    if (Number.isFinite(count)) out.set(ticker, count);
  }
  return out;
}

/** Walk previous `VOLUME_HISTORY_DAYS` calendar days. For each ticker we have
 *  today, collect prior volumes whenever those days have a snapshot. Returns
 *  newest-first arrays. */
function buildVolumeHistory(
  brainDir: string,
  todayDate: string,
  today: Map<string, PriceRow>,
  ctx: MinionJobContext,
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const ticker of today.keys()) out.set(ticker, []);

  const todayDt = new Date(todayDate + 'T08:00:00+08:00');
  for (let i = 1; i <= VOLUME_HISTORY_DAYS; i++) {
    if (ctx.signal.aborted) break;
    const d = new Date(todayDt);
    d.setUTCDate(d.getUTCDate() - i);
    const ds = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    const dir = join(brainDir, 'prices', 'twse', ds);
    if (!existsSync(dir)) continue;
    const prior = readPriceSnapshots(dir);
    for (const [ticker, list] of out) {
      const row = prior.get(ticker);
      if (row && row.volume > 0) list.push(row.volume);
    }
  }
  return out;
}

// ===========================================================================
// minimal frontmatter parser
// ---------------------------------------------------------------------------
// Why not import yaml-lite: keeping this handler dependency-light. The
// frontmatter shape we read is flat-string scalars + one nested `ohlcv.*`
// block; a Map<dotted-path, string> is the smallest correct representation.
// ===========================================================================

function parseFrontmatter(raw: string): Map<string, string> | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const lines = m[1]!.split('\n');
  const out = new Map<string, string>();
  let currentBlock = '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
    const trimmed = line.trim();
    if (indent === 0 && trimmed.endsWith(':') && !trimmed.includes(' ')) {
      currentBlock = trimmed.slice(0, -1);
      continue;
    }
    const colon = trimmed.indexOf(':');
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (indent > 0 && currentBlock) {
      out.set(`${currentBlock}.${key}`, value);
    } else {
      out.set(key, value);
      currentBlock = '';
    }
  }
  return out;
}

function stripQuotes(s: string): string {
  return s.replace(/^"(.*)"$/, '$1');
}

// ===========================================================================
// markdown renderer
// ===========================================================================

function renderHeatReport(
  date: string,
  ranked: HeatScoreOutput[],
  weights: HeatWeights,
  available: { prices: boolean; institutional_flow: boolean; news: boolean },
): string {
  const top20 = ranked.slice(0, 20);
  const bottom10 = ranked.length > 20 ? ranked.slice(-10).reverse() : [];

  const fmtRow = (r: HeatScoreOutput, rank: number): string => {
    return `${rank}. [[tickers/${r.ticker}]] — heat **${(r.heat_score * 100).toFixed(1)}** ` +
      `(法人 ${(r.signals.institutional_flow * 100).toFixed(0)}, ` +
      `量 ${(r.signals.volume_anomaly * 100).toFixed(0)}, ` +
      `新聞 ${(r.signals.news_density * 100).toFixed(0)}) — ${r.rationale}`;
  };

  return `---
type: heat_report
slug: playbooks/heat/${date}
date: ${date}
market: TWSE
weights:
  institutional_flow: ${weights.institutional_flow}
  volume_anomaly: ${weights.volume_anomaly}
  news_density: ${weights.news_density}
tickers_scored: ${ranked.length}
signals_used:
  prices: ${available.prices}
  institutional_flow: ${available.institutional_flow}
  news: ${available.news}
---

# Market Heat Report — ${date}

Composite heat-score per ticker on a 0-100 scale. Weighting:
${(weights.institutional_flow * 100).toFixed(0)}% 法人籌碼 +
${(weights.volume_anomaly * 100).toFixed(0)}% 量價異常 +
${(weights.news_density * 100).toFixed(0)}% 新聞密度。

訊號可用性: prices=${available.prices ? '✓' : '✗'},
flow=${available.institutional_flow ? '✓' : '✗'},
news=${available.news ? '✓' : '✗'}

## Top 20 Hottest Tickers

${top20.map((r, i) => fmtRow(r, i + 1)).join('\n') || '(無資料)'}

${bottom10.length > 0 ? `## Bottom 10 (signal-quiet)\n\n${bottom10.map((r, i) => fmtRow(r, i + 1)).join('\n')}\n` : ''}

## Methodology Notes

- **法人籌碼信號** = tanh(|net_intensity| × 10)，5% 強度 ≈ 46 分，10% ≈ 76 分
- **量價異常信號** = tanh(|z-score| / 2)，2σ ≈ 96 分。歷史資料 <10 日時降階用 ratio
- **新聞密度信號** = min(mentions / 5, 1)，當日 5 次提及打滿分
- 三個信號獨立 [0,1]，缺資料的訊號貢獻 0，不影響其他訊號

合計分數沒有「絕對好壞」— 它是「今天值得看的清單」訊號合成，不是買賣建議。
任何下游推送都應通過合規層先過濾。

關聯：[[playbooks]]、[[themes/passive-components]]、[[themes/ai-infrastructure]]
`;
}

// ===========================================================================
// param validators
// ===========================================================================

function validateParams(data: Record<string, unknown>): MarketHeatParams {
  if (typeof data.brain_dir !== 'string' || !data.brain_dir) {
    throw new UnrecoverableError('market-heat: missing required param "brain_dir"');
  }
  if (data.date !== undefined && typeof data.date !== 'string') {
    throw new UnrecoverableError('market-heat: "date" must be a string');
  }
  let weights: Partial<HeatWeights> | undefined;
  if (data.weights !== undefined) {
    if (!data.weights || typeof data.weights !== 'object' || Array.isArray(data.weights)) {
      throw new UnrecoverableError('market-heat: "weights" must be an object');
    }
    const w = data.weights as Record<string, unknown>;
    weights = {};
    for (const k of ['institutional_flow', 'volume_anomaly', 'news_density'] as const) {
      if (w[k] !== undefined) {
        if (typeof w[k] !== 'number') {
          throw new UnrecoverableError(`market-heat: weights.${k} must be a number`);
        }
        weights[k] = w[k] as number;
      }
    }
  }
  return {
    brain_dir: data.brain_dir,
    date: data.date as string | undefined,
    weights,
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
    throw new UnrecoverableError(`market-heat: invalid date "${input}"`);
  }
  return input;
}
