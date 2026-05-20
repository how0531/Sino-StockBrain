/**
 * Stock data source adapter — single contract for daily quotes + institutional
 * flow that all handlers route through. Swap implementations (mock → real DB)
 * by adding a new class behind `resolveStockDataSource(name)`.
 *
 * Current implementations:
 *   - 'mock'         — deterministic simulated data, no network calls (default).
 *   - 'twse-openapi' — pulls from public TWSE Open API. Phase-2 production.
 *
 * Future planned:
 *   - 'customer-db'  — your internal ticker DB (institutional flow + OHLCV).
 *
 * Why an interface, not a function: handlers care about three things —
 * a snapshot of all daily quotes, the institutional flow for the same day,
 * and (optionally) per-ticker history for moving-average computation. Each
 * source implements all three so the handler code stays identical regardless
 * of where bytes come from.
 */

export interface DailyQuote {
  ticker: string;        // 證券代號（保留前導零，e.g. "2330"）
  name: string;          // 證券名稱
  date: string;          // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  prev_close: number;
  change: number;        // close - prev_close
  change_pct: number;    // (close - prev_close) / prev_close * 100
  volume: number;        // 成交股數
  trades: number;        // 成交筆數
  turnover: number;      // 成交金額 TWD
}

export interface InstitutionalFlow {
  ticker: string;
  name: string;
  date: string;
  /** 外資及陸資 net buy/sell (shares; +buy, -sell) */
  foreign_net: number;
  /** 投信 net */
  trust_net: number;
  /** 自營商 net (避險 + 自行買賣合計) */
  dealer_net: number;
  /** Sum of the three. Convenience field. */
  total_net: number;
  /** total_net / volume (signed intensity). Convenience field, may be omitted. */
  net_intensity?: number;
}

export interface MarketSnapshot {
  market: Market;
  date: string;
  /** Source name that produced this snapshot — bubbles into the markdown
   *  frontmatter so downstream consumers know whether they're looking at
   *  mock data or real data. Anchor for the eventual swap. */
  source: string;
  quotes: DailyQuote[];
}

export type Market = 'TWSE' | 'TPEX' | 'NASDAQ' | 'NYSE';

export interface StockDataSource {
  /** Name appears in frontmatter so downstream readers can distinguish mock
   *  from real data. Keep stable across refactors. */
  readonly name: string;

  /** Returns ALL daily quotes for the market on a given trading day.
   *  On non-trading days (weekends, holidays) implementations should return
   *  `{ quotes: [] }` rather than throwing — callers check for empty. */
  getDailySnapshot(market: Market, date: string): Promise<MarketSnapshot>;

  /** Returns institutional flow for ALL tickers on a given trading day.
   *  Some implementations (mock) generate this alongside the daily snapshot;
   *  others (TWSE Open API) may make a separate HTTP call. */
  getInstitutionalFlow(market: Market, date: string): Promise<InstitutionalFlow[]>;
}

export interface ResolveOpts {
  /** Absolute path to the brain repo. Some sources read `tickers/` to know
   *  which symbols to populate (mock) or to know the watchlist (real DB). */
  brain_dir: string;
}

/** Factory. Adding a new source = add one case here + one file in this dir. */
export async function resolveStockDataSource(
  name: string,
  opts: ResolveOpts,
): Promise<StockDataSource> {
  switch (name) {
    case 'mock': {
      const mod = await import('./mock-stock-data.ts');
      return new mod.MockStockDataSource(opts);
    }
    case 'twse-openapi': {
      const mod = await import('./twse-openapi-stock-data.ts');
      return new mod.TwseOpenApiStockDataSource();
    }
    default:
      throw new Error(
        `Unknown stock data source "${name}". Valid: mock, twse-openapi. ` +
        `To add a custom source, drop a new file in src/core/data-sources/ ` +
        `that implements StockDataSource and register it here.`,
      );
  }
}
