/**
 * `attribution-gather` job handler — Phase E step 2 (the attribution core).
 *
 * For the day's movers (input from `movers/<date>.json` written by E1
 * mover-detect), gather 5 evidence streams and score each as a candidate
 * cause. Writes per-mover JSON for the chatbot to pick a narrative, plus a
 * human-readable `_hot.md` for direct browsing.
 *
 * Evidence types (each scored 0–1, heuristic, NOT historically calibrated —
 * a TODO once we have a ground-truth labelled sample):
 *
 *   institutional_flow  外資+投信 net intensity 正向 (買超佔成交量比例)
 *   theme_rotation      所屬概念群當日 peer avg - market avg
 *   news_catalyst       近 7 日新聞提及次數 (含 user-research 報告)
 *   revenue_trigger     月營收公告日落在 ±2 日窗
 *   broker_coverage     分析師覆蓋深度 (連帶 EPS 成長, 不是趨勢轉折但作 base)
 *
 * Output:
 *   <brain_dir>/attribution/<YYYY-MM-DD>/<code>.json   per-mover evidence pack
 *   <brain_dir>/attribution/<YYYY-MM-DD>/_hot.md       人讀 top 漲幅 + top 證據
 *
 * Scope: top_gainers ∪ top_turnover (dedup) from movers JSON, capped at 50.
 * Top_losers is intentionally skipped — promoting trading opportunity (the
 * project goal) maps to gainers; losers attribution is a different exercise.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MinionJobContext } from '../types.ts';
import { UnrecoverableError } from '../types.ts';
import type { DailyQuote, InstitutionalFlow } from '../../data-sources/stock-data.ts';
import { resolveStockDataSource } from '../../data-sources/stock-data.ts';

const NEWS_WINDOW_DAYS = 7;
const MAX_ATTRIBUTION_TICKERS = 50;
const MIN_THEME_PEERS = 3;          // theme rotation: need ≥3 other peers in the theme today

export interface AttributionGatherParams {
  brain_dir: string;
  date?: string;
  source?: string;
}

export interface AttributionGatherResult {
  status: 'ok' | 'skipped';
  reason?: string;
  date: string;
  source: string;
  tickers_processed: number;
  output_dir: string;
}

interface Evidence {
  type: 'institutional_flow' | 'theme_rotation' | 'news_catalyst' | 'revenue_trigger' | 'broker_coverage';
  score: number;
  evidence: string;
  data_ref?: string;
  details?: Record<string, unknown>;
}

interface AttributionBundle {
  ticker: string;
  name: string;
  date: string;
  price_change_pct: number;
  turnover: number;
  market_avg_pct: number;
  candidates: Evidence[];
  narrative_hints: string[];
}

interface MoversFile {
  date: string;
  top_gainers: Array<{ ticker: string; name: string; close: number; change_pct: number; volume: number; turnover: number }>;
  top_turnover: Array<{ ticker: string; name: string; close: number; change_pct: number; volume: number; turnover: number }>;
}

interface ConceptGroup { tag: string; codes: string[]; }
interface NewsMention { date: string; slug: string; title: string; source: string; sentiment?: string; events?: string[]; }

export async function attributionGatherHandler(
  ctx: MinionJobContext,
): Promise<AttributionGatherResult> {
  const params = validateParams(ctx.data);
  const sourceName = params.source ?? 'metabase';

  // 1. Load mover input (E1's output is the entry list)
  const moversPath = params.date
    ? join(params.brain_dir, 'movers', `${params.date}.json`)
    : resolveLatestMovers(params.brain_dir);
  if (!moversPath || !existsSync(moversPath)) {
    throw new UnrecoverableError(
      `attribution-gather: no movers file at ${moversPath ?? 'movers/'}; run movers-detect first`,
    );
  }
  const movers: MoversFile = JSON.parse(readFileSync(moversPath, 'utf-8'));
  const date = movers.date;
  const targets = dedupTopTickers(movers, MAX_ATTRIBUTION_TICKERS);
  await ctx.log(`[attribution-gather] date=${date} targets=${targets.length}`);

  // 2. Market context (quotes + intra-day flow + concept groups)
  const dataSource = await resolveStockDataSource(sourceName, { brain_dir: params.brain_dir });
  const snap = await dataSource.getDailySnapshot('TWSE', date);
  if (snap.quotes.length === 0) {
    return { status: 'skipped', reason: `no quotes for ${date}`, date, source: sourceName, tickers_processed: 0, output_dir: '' };
  }
  const quoteByCode = new Map<string, DailyQuote>(snap.quotes.map((q) => [q.ticker, q]));
  const marketAvg = mean(snap.quotes.filter((q) => /^\d{4}$/.test(q.ticker)).map((q) => q.change_pct));

  const flowByCode = new Map<string, InstitutionalFlow>();
  if (typeof dataSource.getInstitutionalFlow === 'function') {
    const flows = await dataSource.getInstitutionalFlow('TWSE', date);
    for (const f of flows) flowByCode.set(f.ticker, f);
  }

  // 3. Concept groups (code ↔ tag — the theme membership lattice)
  const groups: ConceptGroup[] = JSON.parse(
    readFileSync(join(import.meta.dir, '../../entities/concept-groups.json'), 'utf-8'),
  );
  const tickerToTags = new Map<string, string[]>();
  const tagToCodes = new Map<string, string[]>();
  for (const g of groups) {
    const tag = g.tag.trim();
    tagToCodes.set(tag, g.codes);
    for (const code of g.codes) {
      const arr = tickerToTags.get(code) ?? [];
      arr.push(tag);
      tickerToTags.set(code, arr);
    }
  }

  // 4. News mentions in last NEWS_WINDOW_DAYS (cheap disk scan — parses
  //    frontmatter hint_tickers + greps [[tickers/X]] in body)
  const newsByTicker = loadRecentNewsMentions(params.brain_dir, date, NEWS_WINDOW_DAYS);

  // 5. Fundamentals (latest snapshots — used for revenue trigger + broker coverage)
  const revIdx = loadLatestFundamentalsIndex(params.brain_dir, 'revenue');
  const epsIdx = loadLatestFundamentalsIndex(params.brain_dir, 'eps');

  // 6. Build evidence per target
  const outDir = join(params.brain_dir, 'attribution', date);
  mkdirSync(outDir, { recursive: true });
  const bundles: AttributionBundle[] = [];
  for (const t of targets) {
    if (ctx.signal.aborted) throw new Error('aborted');
    const b = buildEvidence({
      ticker: t.ticker, name: t.name, date, marketAvg,
      quoteByCode, flowByCode, tickerToTags, tagToCodes,
      newsByTicker, revIdx, epsIdx,
    });
    writeFileSync(join(outDir, `${t.ticker}.json`), JSON.stringify(b, null, 0), 'utf-8');
    bundles.push(b);
  }

  writeFileSync(join(outDir, '_hot.md'), renderHot(bundles, date), 'utf-8');
  await ctx.log(`[attribution-gather] wrote ${bundles.length} bundles + _hot.md to ${outDir}`);

  return { status: 'ok', date, source: sourceName, tickers_processed: bundles.length, output_dir: outDir };
}

// ---------------------------------------------------------------------------
// Evidence building

function buildEvidence(args: {
  ticker: string; name: string; date: string; marketAvg: number;
  quoteByCode: Map<string, DailyQuote>;
  flowByCode: Map<string, InstitutionalFlow>;
  tickerToTags: Map<string, string[]>;
  tagToCodes: Map<string, string[]>;
  newsByTicker: Map<string, NewsMention[]>;
  revIdx: FundIndex | null;
  epsIdx: FundIndex | null;
}): AttributionBundle {
  const { ticker, name, date, marketAvg, quoteByCode, flowByCode, tickerToTags, tagToCodes, newsByTicker, revIdx, epsIdx } = args;
  const q = quoteByCode.get(ticker);
  const candidates: Evidence[] = [];
  const hints: string[] = [];

  // (1) institutional_flow — direction-aligned with the day's move.
  // For attribution of a GAINER, positive intensity is causal; negative net
  // (institutions selling against a rising price) is interesting context
  // but NOT the cause — score it near zero, surface as a "divergence" hint
  // rather than promote it. Mirror logic for losers (change_pct < 0).
  const f = flowByCode.get(ticker);
  const move = q?.change_pct ?? 0;
  if (f && (f.total_net !== 0)) {
    const intensity = f.net_intensity ?? 0;
    const aligned = (move >= 0 ? intensity : -intensity); // positive when flow direction matches move
    const score = Math.min(Math.max(aligned * 10, 0), 1); // 0 when contrarian; 1.0 at 10% aligned intensity
    let evidence: string;
    if (aligned >= 0) {
      evidence =
        `外資+投信合計 net ${formatShares(f.total_net)} 股 (強度 ${(intensity * 100).toFixed(1)}%)，` +
        `外資 ${formatShares(f.foreign_net)}，投信 ${formatShares(f.trust_net)}`;
      if (intensity > 0.05) hints.push('外資/投信買盤強');
    } else {
      // Contrarian — keep on record but score 0 so it doesn't claim causation.
      evidence =
        `逆勢：外資+投信 net ${formatShares(f.total_net)} 股 (強度 ${(intensity * 100).toFixed(1)}%) 與股價方向相反，` +
        `非因法人推動`;
      hints.push('法人逆勢 (散戶推動)');
    }
    if (score >= 0.05 || aligned < 0) { // skip near-zero aligned, but keep contrarian as hint
      candidates.push({
        type: 'institutional_flow', score, evidence,
        data_ref: `institutional-flow/twse/${date}/${ticker}`,
        details: { foreign_net: f.foreign_net, trust_net: f.trust_net, total_net: f.total_net, intensity, aligned_with_move: aligned >= 0 },
      });
    }
  }

  // (2) theme_rotation
  const tags = tickerToTags.get(ticker) ?? [];
  if (tags.length > 0) {
    let bestTag: string | null = null;
    let bestPeerAvg = -Infinity;
    let bestPeerCount = 0;
    for (const tag of tags) {
      const peers = (tagToCodes.get(tag) ?? []).filter((c) => c !== ticker);
      const peerPcts: number[] = [];
      for (const p of peers) {
        const pq = quoteByCode.get(p);
        if (pq) peerPcts.push(pq.change_pct);
      }
      if (peerPcts.length >= MIN_THEME_PEERS) {
        const avg = mean(peerPcts);
        if (avg > bestPeerAvg) { bestPeerAvg = avg; bestTag = tag; bestPeerCount = peerPcts.length; }
      }
    }
    if (bestTag != null && bestPeerAvg > marketAvg + 1.0) {
      // Theme outperforming market by ≥1pp → rotation signal
      const excess = bestPeerAvg - marketAvg;
      const score = Math.min(excess / 4, 1); // 4pp excess → 1.0
      candidates.push({
        type: 'theme_rotation', score,
        evidence: `「${bestTag}」族群當日 ${bestPeerCount} 檔同儕均漲 ${bestPeerAvg.toFixed(2)}% (大盤均 ${marketAvg.toFixed(2)}%, 超漲 ${excess.toFixed(2)}pp)`,
        data_ref: `concept-groups:${bestTag}`,
        details: { theme: bestTag, peer_count: bestPeerCount, peer_avg_pct: bestPeerAvg, market_avg_pct: marketAvg, excess_pp: excess },
      });
      hints.push(`族群輪動 — ${bestTag}`);
    }
  }

  // (3) news_catalyst (近 NEWS_WINDOW_DAYS 日)
  const mentions = newsByTicker.get(ticker) ?? [];
  if (mentions.length > 0) {
    const score = Math.min(mentions.length / 5, 1);
    const recent = mentions.slice(-3).reverse();
    const evidence =
      `近 ${NEWS_WINDOW_DAYS} 日 ${mentions.length} 則新聞 / 研報；近期：` +
      recent.map((m) => `「${m.title}」 (${m.source}, ${m.date})`).join('、');
    candidates.push({
      type: 'news_catalyst', score, evidence,
      details: {
        count: mentions.length,
        recent: recent.map((m) => ({ slug: m.slug, title: m.title, source: m.source, date: m.date, sentiment: m.sentiment, events: m.events })),
      },
    });
    const hasResearch = mentions.some((m) => m.source.startsWith('user-research'));
    if (hasResearch) hints.push('有研究報告覆蓋');
    if (mentions.length >= 3) hints.push('新聞密度高');
  }

  // (4) revenue_trigger
  if (revIdx && revIdx.byTicker[ticker]) {
    const rev = revIdx.byTicker[ticker];
    const ann = rev.announce_date as string | undefined;
    if (ann && dayDistance(ann, date) <= 2) {
      candidates.push({
        type: 'revenue_trigger', score: 1.0,
        evidence: `${ann} 公告 ${revIdx.ymDir} 月營收 YoY ${signedPct(rev.yoy_pct as number)} (MoM ${signedPct(rev.mom_pct as number)})`,
        data_ref: `fundamentals/revenue/${revIdx.ymDir}/${ticker}`,
        details: { announce_date: ann, yoy_pct: rev.yoy_pct, mom_pct: rev.mom_pct, year_month: revIdx.ymDir },
      });
      hints.push('月營收公告日');
    }
  }

  // (5) broker_coverage (base signal — not a trigger, just credibility context)
  if (epsIdx && epsIdx.byTicker[ticker]) {
    const e = epsIdx.byTicker[ticker];
    const ac = (e.analyst_count_next as number | null) ?? (e.analyst_count as number | null) ?? 0;
    if (ac >= 5) {
      const nyG = e.next_year_growth_pct as number | null;
      const score = Math.min(ac / 20, 0.6); // capped at 0.6 — coverage isn't a trigger
      candidates.push({
        type: 'broker_coverage', score,
        evidence: `${ac} 家機構覆蓋；明年 EPS 估 ${e.next_year_eps ?? '—'} 元${nyG != null ? ` (成長 ${signedPct(nyG)})` : ''}`,
        data_ref: `fundamentals/eps/${epsIdx.ymDir}/${ticker}`,
        details: { analyst_count_next: ac, next_year_eps: e.next_year_eps, next_year_growth_pct: nyG },
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  return {
    ticker, name, date,
    price_change_pct: q?.change_pct ?? 0,
    turnover: q?.turnover ?? 0,
    market_avg_pct: marketAvg,
    candidates, narrative_hints: hints,
  };
}

// ---------------------------------------------------------------------------
// Disk / data helpers

interface FundIndex { ymDir: string; byTicker: Record<string, Record<string, unknown>>; }

function loadLatestFundamentalsIndex(brainDir: string, kind: 'revenue' | 'eps'): FundIndex | null {
  const dir = join(brainDir, 'fundamentals', kind);
  if (!existsSync(dir)) return null;
  const months = readdirSync(dir).filter((f) => /^\d{4}-\d{2}$/.test(f)).sort();
  if (!months.length) return null;
  const ymDir = months[months.length - 1]!;
  const idx = join(dir, ymDir, '_index.json');
  if (!existsSync(idx)) return null;
  const data = JSON.parse(readFileSync(idx, 'utf-8'));
  return { ymDir, byTicker: data.by_ticker ?? {} };
}

function loadRecentNewsMentions(brainDir: string, asOf: string, windowDays: number): Map<string, NewsMention[]> {
  const newsRoot = join(brainDir, 'news');
  const out = new Map<string, NewsMention[]>();
  if (!existsSync(newsRoot)) return out;
  const cutoff = new Date(asOf + 'T00:00:00Z').getTime() - windowDays * 86400_000;
  const dates = readdirSync(newsRoot).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= asOf);
  for (const d of dates) {
    if (new Date(d + 'T00:00:00Z').getTime() < cutoff) continue;
    const dir = join(newsRoot, d);
    for (const fname of readdirSync(dir)) {
      if (!fname.endsWith('.md') || fname.startsWith('_')) continue;
      const path = join(dir, fname);
      const raw = readFileSync(path, 'utf-8');
      const mention = parseNewsMention(raw, d, fname);
      if (!mention) continue;
      for (const code of mention.tickers) {
        const arr = out.get(code) ?? [];
        arr.push({ date: d, slug: mention.slug, title: mention.title, source: mention.source, sentiment: mention.sentiment, events: mention.events });
        out.set(code, arr);
      }
    }
  }
  // Stable sort per ticker by date asc
  for (const arr of out.values()) arr.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

function parseNewsMention(raw: string, date: string, fname: string): {
  slug: string; title: string; source: string; sentiment?: string; events?: string[]; tickers: string[];
} | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (!fm) return null;
  const front = fm[1]!;
  const body = fm[2]!;
  const fget = (k: string): string => (new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(front)?.[1] ?? '').trim();
  const slug = fget('slug') || `news/${date}/${fname.replace(/\.md$/, '')}`;
  const title = (/^#\s+(.+)$/m.exec(body)?.[1] ?? '').trim();
  const source = fget('source');
  // hint_tickers may be inline array; greedy parse "[..., ...]"
  const tickers = new Set<string>();
  const hint = /^hint_tickers:\s*\[(.*)\]/m.exec(front);
  if (hint) for (const t of hint[1]!.split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''))) if (t) tickers.add(t);
  // body wikilinks
  for (const m of body.matchAll(/\[\[tickers\/([A-Za-z0-9_-]+)\]\]/g)) tickers.add(m[1]!);
  return { slug, title, source, tickers: [...tickers] };
}

function resolveLatestMovers(brainDir: string): string | null {
  const dir = join(brainDir, 'movers');
  if (!existsSync(dir)) return null;
  const days = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  if (!days.length) return null;
  return join(dir, days[days.length - 1]!);
}

function dedupTopTickers(m: MoversFile, cap: number): Array<{ ticker: string; name: string }> {
  const seen = new Set<string>();
  const out: Array<{ ticker: string; name: string }> = [];
  for (const list of [m.top_gainers, m.top_turnover]) {
    for (const r of list) {
      if (seen.has(r.ticker)) continue;
      seen.add(r.ticker);
      out.push({ ticker: r.ticker, name: r.name });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Renderers + small utils

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function signedPct(n: number): string { return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`; }
function formatShares(n: number): string { return n.toLocaleString('en'); }
function dayDistance(a: string, b: string): number {
  const da = new Date(a + 'T00:00:00Z').getTime();
  const db = new Date(b + 'T00:00:00Z').getTime();
  return Math.abs(da - db) / 86400_000;
}

function renderHot(bundles: AttributionBundle[], date: string): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push('type: attribution_hot');
  lines.push(`slug: attribution/${date}/_hot`);
  lines.push(`date: ${date}`);
  lines.push(`tickers: ${bundles.length}`);
  lines.push('---');
  lines.push('');
  lines.push(`# 個股動能歸因 (Hot) — ${date}`);
  lines.push('');
  lines.push('每檔列其 top-3 證據候選；分數 0–1 為啟發式 (尚未經歷史校準)。');
  lines.push('');
  // Sort by price change desc for the report
  const sorted = [...bundles].sort((a, b) => b.price_change_pct - a.price_change_pct);
  for (const b of sorted) {
    lines.push(`## [[tickers/${b.ticker}]] ${b.name} ${signedPct(b.price_change_pct)}  (大盤 ${signedPct(b.market_avg_pct)})`);
    lines.push('');
    if (b.narrative_hints.length) {
      lines.push(`> 提示：${b.narrative_hints.join('、')}`);
      lines.push('');
    }
    if (b.candidates.length === 0) {
      lines.push('_(無顯著證據候選)_');
    } else {
      for (const c of b.candidates.slice(0, 3)) {
        lines.push(`- **${c.type}** (score ${c.score.toFixed(2)}) — ${c.evidence}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------

function validateParams(data: Record<string, unknown>): AttributionGatherParams {
  if (typeof data.brain_dir !== 'string' || !data.brain_dir) {
    throw new UnrecoverableError('attribution-gather: missing required param "brain_dir"');
  }
  if (data.date !== undefined) {
    if (typeof data.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
      throw new UnrecoverableError('attribution-gather: "date" must be "YYYY-MM-DD"');
    }
  }
  if (data.source !== undefined && typeof data.source !== 'string') {
    throw new UnrecoverableError('attribution-gather: "source" must be a string');
  }
  return {
    brain_dir: data.brain_dir,
    date: data.date as string | undefined,
    source: data.source as string | undefined,
  };
}
