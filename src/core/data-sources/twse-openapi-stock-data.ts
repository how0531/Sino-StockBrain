/**
 * Real-data adapter — TWSE Open API.
 *
 * Free, no auth, public. Useful as the production source once the customer's
 * internal DB isn't available or as a cross-check. Currently feature-incomplete:
 * `getInstitutionalFlow` requires a separate endpoint (MI_QFIIS_sort_20) that
 * is not yet wired here. Returns empty array until implemented.
 *
 * Swap to a real ticker DB by creating a sibling file (e.g.
 * `customer-db-stock-data.ts`) implementing the same `StockDataSource`
 * interface, then adding a `case` in `resolveStockDataSource()`.
 */

import type {
  DailyQuote,
  InstitutionalFlow,
  Market,
  MarketSnapshot,
  StockDataSource,
} from './stock-data.ts';

const TWSE_STOCK_DAY_ALL_URL =
  'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL';

const FETCH_TIMEOUT_MS = 15_000;

interface TwseQuoteRow {
  Code: string;
  Name: string;
  TradeVolume: string;
  TradeValue: string;
  OpeningPrice: string;
  HighestPrice: string;
  LowestPrice: string;
  ClosingPrice: string;
  Change: string;
  Transaction: string;
}

export class TwseOpenApiStockDataSource implements StockDataSource {
  readonly name = 'twse-openapi';

  async getDailySnapshot(market: Market, date: string): Promise<MarketSnapshot> {
    if (market !== 'TWSE') {
      throw new Error(`TwseOpenApi only supports market=TWSE, got ${market}`);
    }
    const rows = await fetchWithTimeout(TWSE_STOCK_DAY_ALL_URL);
    return {
      market,
      date,
      source: this.name,
      quotes: rows.map((r) => rowToQuote(r, date)),
    };
  }

  async getInstitutionalFlow(_market: Market, _date: string): Promise<InstitutionalFlow[]> {
    // TODO: wire to https://openapi.twse.com.tw/v1/fund/MI_QFIIS_sort_20
    // (or equivalent) when the customer DB isn't available.
    return [];
  }
}

async function fetchWithTimeout(url: string): Promise<TwseQuoteRow[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
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
  }
}

function rowToQuote(row: TwseQuoteRow, date: string): DailyQuote {
  const close = num(row.ClosingPrice);
  const change = num(row.Change);
  const prevClose = close - change;
  return {
    ticker: row.Code,
    name: row.Name,
    date,
    open: num(row.OpeningPrice),
    high: num(row.HighestPrice),
    low: num(row.LowestPrice),
    close,
    prev_close: prevClose,
    change,
    change_pct: prevClose > 0 ? (change / prevClose) * 100 : 0,
    volume: num(row.TradeVolume),
    trades: num(row.Transaction),
    turnover: num(row.TradeValue),
  };
}

function num(s: string): number {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}
