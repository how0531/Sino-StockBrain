/**
 * Mock stock data source — deterministic, statistically realistic simulated
 * data for OHLCV + institutional flow.
 *
 * Design goals:
 *   1. Deterministic. Same `(ticker, date)` always returns the same numbers,
 *      so iteration on heat-score formulas, anomaly thresholds, etc. is
 *      reproducible. Seed is derived via FNV-1a hash of `ticker + date`.
 *
 *   2. Statistically realistic. Daily returns are normal-ish (Box-Muller),
 *      volume is log-normal around a per-ticker baseline, institutional flow
 *      correlates with daily return at realistic strengths. Real markets do
 *      this; pure uniform noise would never trigger `find_anomalies`.
 *
 *   3. Watchlist-aware. Reads `<brain_dir>/tickers/*.md` to know which
 *      symbols to populate. Tickers without a baseline entry use a default
 *      (price 100, vol 2%, avg volume 5M).
 *
 *   4. Event injection. ~5% of (ticker, day) combos get a 3σ volume spike
 *      with a correlated price move, so anomaly detection has something to
 *      detect even on quiet weeks.
 *
 * What this is NOT: a backtesting engine. There is no auto-correlation
 * between consecutive days, no realistic factor model, no sector clustering.
 * Each day's numbers are drawn independently. Good enough to exercise the
 * pipeline end-to-end; replace with real data before any real decisions ride
 * on the output.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DailyQuote,
  InstitutionalFlow,
  Market,
  MarketSnapshot,
  ResolveOpts,
  StockDataSource,
} from './stock-data.ts';

/** Per-ticker baseline parameters. Numbers are illustrative, NOT taken from
 *  a specific real trading day — the mock is for pipeline-shape testing,
 *  not for any kind of backtest. */
interface TickerBaseline {
  name: string;
  /** Reference closing price (TWD or USD depending on market). */
  base_price: number;
  /** Daily return standard deviation (decimal, e.g. 0.015 = 1.5%). */
  daily_vol: number;
  /** Average daily volume (shares). */
  avg_volume: number;
}

/** Baseline table for the 10 seeded tickers + a default. */
const TICKER_BASELINES: Record<string, TickerBaseline> = {
  // Taiwan core (TWSE)
  '2330': { name: '台積電',   base_price: 1100, daily_vol: 0.015, avg_volume: 30_000_000 },
  '2317': { name: '鴻海',     base_price: 210,  daily_vol: 0.020, avg_volume: 50_000_000 },
  '2454': { name: '聯發科',   base_price: 1500, daily_vol: 0.020, avg_volume: 8_000_000 },
  '2308': { name: '台達電',   base_price: 410,  daily_vol: 0.018, avg_volume: 12_000_000 },
  '3008': { name: '大立光',   base_price: 2400, daily_vol: 0.020, avg_volume: 1_000_000 },
  // US core (NASDAQ)
  'NVDA':  { name: 'NVIDIA',  base_price: 130,  daily_vol: 0.035, avg_volume: 250_000_000 },
  'AAPL':  { name: 'Apple',   base_price: 210,  daily_vol: 0.015, avg_volume: 60_000_000 },
  'MSFT':  { name: 'Microsoft', base_price: 420, daily_vol: 0.013, avg_volume: 25_000_000 },
  'GOOGL': { name: 'Alphabet', base_price: 170, daily_vol: 0.015, avg_volume: 30_000_000 },
  'TSLA':  { name: 'Tesla',   base_price: 250,  daily_vol: 0.040, avg_volume: 80_000_000 },
};

const DEFAULT_BASELINE: TickerBaseline = {
  name: '(unknown)',
  base_price: 100,
  daily_vol: 0.020,
  avg_volume: 5_000_000,
};

/** Probability a given (ticker, date) gets a 3σ volume + ±2σ price event. */
const EVENT_PROBABILITY = 0.05;

export class MockStockDataSource implements StockDataSource {
  readonly name = 'mock';
  private readonly brainDir: string;

  constructor(opts: ResolveOpts) {
    this.brainDir = opts.brain_dir;
  }

  async getDailySnapshot(market: Market, date: string): Promise<MarketSnapshot> {
    const tickers = this.tickersForMarket(market);
    const quotes: DailyQuote[] = tickers.map((ticker) => simulateDailyQuote(ticker, date));
    return { market, date, source: this.name, quotes };
  }

  async getInstitutionalFlow(market: Market, date: string): Promise<InstitutionalFlow[]> {
    const tickers = this.tickersForMarket(market);
    // Institutional flow correlates with daily return → reuse the same quote
    // generator so flow + quote tell a consistent story for the same (ticker, date).
    return tickers.map((ticker) => {
      const quote = simulateDailyQuote(ticker, date);
      return simulateInstitutionalFlow(quote);
    });
  }

  /** Read `tickers/*.md` to figure out which symbols to simulate, filter by
   *  market (TW codes are 4-digit numeric; US tickers are alphabetic).
   *  Falls back to the full baseline table if `tickers/` doesn't exist. */
  private tickersForMarket(market: Market): string[] {
    const dir = join(this.brainDir, 'tickers');
    let codes: string[] = [];
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.md')) continue;
        if (name.startsWith('_')) continue;
        codes.push(name.replace(/\.md$/, ''));
      }
    } else {
      codes = Object.keys(TICKER_BASELINES);
    }
    if (market === 'TWSE' || market === 'TPEX') {
      return codes.filter((c) => /^\d{3,6}$/.test(c));
    }
    if (market === 'NASDAQ' || market === 'NYSE') {
      return codes.filter((c) => /^[A-Z]{1,5}$/.test(c));
    }
    return [];
  }
}

// ===========================================================================
// PURE simulation primitives — exported so handlers / tests can re-use them
// ===========================================================================

/** Generates one ticker's daily OHLCV deterministically. Exposed for tests
 *  and so other handlers (e.g. multi-day moving average backfill) can call
 *  the same generator without instantiating the class. */
export function simulateDailyQuote(ticker: string, date: string): DailyQuote {
  const baseline = TICKER_BASELINES[ticker] ?? { ...DEFAULT_BASELINE, name: ticker };
  const rng = seededRng(`${ticker}:${date}`);

  // Daily return ~ N(0, vol). Box-Muller from two uniforms.
  let dailyReturn = boxMuller(rng) * baseline.daily_vol;

  // Volume ~ log-normal around baseline. log-vol-std controls how much
  // day-to-day volume varies; 0.35 is a reasonable real-market scale.
  let logVol = boxMuller(rng) * 0.35;
  let volMultiplier = Math.exp(logVol);

  // Inject occasional events: bigger vol + correlated move.
  const eventRoll = rng();
  let isEvent = false;
  if (eventRoll < EVENT_PROBABILITY) {
    isEvent = true;
    volMultiplier *= 3 + rng() * 2;                       // 3-5x volume
    const direction = rng() < 0.5 ? -1 : 1;
    dailyReturn = direction * baseline.daily_vol * (2 + rng() * 2); // ±2-4σ move
  }

  const prevClose = baseline.base_price;
  const close = roundPrice(prevClose * (1 + dailyReturn));
  const change = roundPrice(close - prevClose);
  const changePct = (change / prevClose) * 100;

  // Open / High / Low: bracket the close with intraday noise.
  const intradayNoise = baseline.daily_vol * 0.6;
  const open = roundPrice(prevClose * (1 + boxMuller(rng) * intradayNoise * 0.3));
  const high = roundPrice(Math.max(open, close) * (1 + Math.abs(boxMuller(rng)) * intradayNoise * 0.5));
  const low = roundPrice(Math.min(open, close) * (1 - Math.abs(boxMuller(rng)) * intradayNoise * 0.5));

  const volume = Math.round(baseline.avg_volume * volMultiplier);
  const trades = Math.round(volume / 500); // rough avg shares-per-trade
  const turnover = Math.round(volume * close);

  // Discard `isEvent` from output; it's an internal-only flag for now. If we
  // later want event tagging in the page frontmatter, surface it explicitly.
  void isEvent;

  return {
    ticker,
    name: baseline.name,
    date,
    open,
    high,
    low,
    close,
    prev_close: prevClose,
    change,
    change_pct: round2(changePct),
    volume,
    trades,
    turnover,
  };
}

export function simulateInstitutionalFlow(quote: DailyQuote): InstitutionalFlow {
  const rng = seededRng(`${quote.ticker}:${quote.date}:institutional`);
  const baseline = TICKER_BASELINES[quote.ticker] ?? { ...DEFAULT_BASELINE, name: quote.ticker };

  // Foreign flow correlates with daily return (foreign tend to chase momentum).
  // Strength: signed |return| / vol → scaled by 0.25 of average volume.
  const returnZ = quote.change_pct / 100 / baseline.daily_vol;
  const foreignBase = returnZ * 0.4 + boxMuller(rng) * 0.2;
  const foreign_net = Math.round(foreignBase * baseline.avg_volume * 0.25);

  // Trust (投信) flow: smaller scale, momentum-following at 0.3 strength.
  const trustBase = returnZ * 0.3 + boxMuller(rng) * 0.15;
  const trust_net = Math.round(trustBase * baseline.avg_volume * 0.05);

  // Dealer (自營商) flow: small, slightly counter-trend (liquidity provision).
  const dealerBase = -returnZ * 0.1 + boxMuller(rng) * 0.2;
  const dealer_net = Math.round(dealerBase * baseline.avg_volume * 0.03);

  const total_net = foreign_net + trust_net + dealer_net;
  const net_intensity = quote.volume > 0 ? round4(total_net / quote.volume) : 0;

  return {
    ticker: quote.ticker,
    name: quote.name,
    date: quote.date,
    foreign_net,
    trust_net,
    dealer_net,
    total_net,
    net_intensity,
  };
}

// ===========================================================================
// PRNG + math helpers
// ===========================================================================

/** Build a seeded PRNG from a string key. FNV-1a hash → mulberry32. */
function seededRng(key: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return mulberry32(h >>> 0);
}

/** Mulberry32 — a small, fast PRNG with good statistical properties for
 *  this kind of simulation. Period 2^32. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box-Muller. Consumes two uniforms per call. */
function boxMuller(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function roundPrice(p: number): number {
  // Match TWSE tick size precision (2 dp for most stocks under 1000).
  return Math.round(p * 100) / 100;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round4(n: number): number { return Math.round(n * 10000) / 10000; }

/** Read raw watchlist set from tickers/*.md. Exported for handlers that
 *  don't need the full data source machinery. */
export function readWatchlist(brainDir: string): Set<string> {
  const dir = join(brainDir, 'tickers');
  const out = new Set<string>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    if (name.startsWith('_')) continue;
    out.add(name.replace(/\.md$/, ''));
  }
  return out;
}

/** Stub for future: read ticker frontmatter to pick up per-ticker overrides
 *  (custom base_price, vol, etc.). Not used yet — left for v2. */
export function _readTickerFrontmatterStub(brainDir: string, ticker: string): string {
  const path = join(brainDir, 'tickers', `${ticker}.md`);
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8').split('---')[1] ?? '';
}
