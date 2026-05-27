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

/** Monthly revenue (月營收) — the highest-signal monthly fundamental. Cadence
 *  differs from price/flow (published ~10th of the following month), so every
 *  consumer must read `year_month` + `announce_date` rather than assume it
 *  matches a trading date. Revenue figures in 元 (source 千 column ×1000);
 *  percent fields are signed. */
export interface MonthlyRevenue {
  ticker: string;
  name: string;
  /** Reporting month, 'YYYYMM' (e.g. '202604'). */
  year_month: string;
  /** 單月合併營收 (元). */
  revenue: number;
  /** 單月合併營收年成長(%). */
  yoy_pct: number;
  /** 單月合併營收月變動(%). */
  mom_pct: number;
  /** 累計合併營收 (元, YTD). */
  cum_revenue: number;
  /** 累計合併營收成長(%) YoY. */
  cum_yoy_pct: number;
  /** 近12月累計合併營收 (元, TTM). */
  ttm_revenue: number;
  /** 近12月營收合併成長(%). */
  ttm_yoy_pct: number;
  /** 近三月合併營收年成長(%). */
  three_month_yoy_pct: number;
  /** 公告日 'YYYY-MM-DD' — the freshness anchor. */
  announce_date: string;
}

/** Analyst-consensus EPS snapshot — monthly rollup of broker estimates.
 *  Source: cmoney."月機構預估盈餘與EPS". Carries TTM actual, current-year
 *  consensus, AND next-year consensus (the headline number for chatbot:
 *  "明年預估 EPS"). Coverage fields (analyst counts) gate confidence —
 *  a 1-broker estimate is not a "consensus". */
export interface ConsensusEPS {
  ticker: string;
  name: string;
  /** Snapshot month, 'YYYYMM'. */
  year_month: string;
  /** 累計近四季 EPS — trailing-twelve-month actual, the anchor vs forecast. */
  ttm_eps: number | null;
  /** 機構估稅後 EPS — current-year consensus. */
  current_year_eps: number | null;
  /** 明年機構估稅後 EPS — NEXT-year consensus (the headline metric). */
  next_year_eps: number | null;
  /** 預估年稅後 EPS 成長(%) — current-year growth implied by consensus. */
  current_year_growth_pct: number | null;
  /** Computed: (next_year_eps - current_year_eps) / current_year_eps * 100.
   *  The chatbot's headline "明年成長 Top N" metric. Null when either side
   *  is missing or current_year_eps <= 0. */
  next_year_growth_pct: number | null;
  /** 預測機構數 — analyst count for current-year estimate (coverage). */
  analyst_count: number | null;
  /** 明年預測機構數 — analyst count for next-year estimate. */
  analyst_count_next: number | null;
  /** 最高/最低本益比 — PE range implied by consensus. */
  pe_high: number | null;
  pe_low: number | null;
  /** 更新日 'YYYY-MM-DD' — freshness anchor (newest broker update). */
  updated_date: string;
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

  /** Latest monthly revenue (月營收) per ticker. OPTIONAL capability — only the
   *  metabase source implements it (mock / twse-openapi don't). `yearMonth` is
   *  'YYYYMM'; omit to let the source resolve the latest available month. */
  getMonthlyRevenue?(market: Market, yearMonth?: string): Promise<MonthlyRevenue[]>;

  /** Analyst-consensus EPS snapshot (current-year + next-year forecast + TTM
   *  actual). OPTIONAL — metabase only. `yearMonth` ('YYYYMM') matches the
   *  cmoney snapshot month; omit for latest. */
  getConsensusEPS?(market: Market, yearMonth?: string): Promise<ConsensusEPS[]>;
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
    case 'metabase': {
      const mod = await import('./metabase-stock-data.ts');
      return new mod.MetabaseStockDataSource();
    }
    default:
      throw new Error(
        `Unknown stock data source "${name}". Valid: mock, twse-openapi, metabase. ` +
        `To add a custom source, drop a new file in src/core/data-sources/ ` +
        `that implements StockDataSource and register it here.`,
      );
  }
}
