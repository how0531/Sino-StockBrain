/**
 * metabase-stock-data.ts — real 量價 + 籌碼 from the company Metabase
 * (ClickHouse behind Metabase's /api/dataset). Implements StockDataSource so
 * the twse-daily-quotes + twse-institutional-flow handlers run on REAL data
 * with `--source metabase` instead of the deterministic mock.
 *
 * Tables (Metabase database id 10):
 *   量價:  cmoney."日收盤表排行"     → DailyQuote (OHLCV + change + volume)
 *   外資:  cmoney."日外資持股與排行"  → InstitutionalFlow.foreign_net
 *
 * Auth: needs METABASE_URL / METABASE_USER / METABASE_PASS in env. Inject them
 * by dot-sourcing the sinopac-metabase skill's scripts/setup.ps1 before running
 * the handler. Metabase is plain HTTP on the internal IP (128.110.x), so there
 * is no TLS-interception dance — bun fetch works directly.
 *
 * v1 scope: 外資 only (the dominant TW institutional signal). 投信 net
 * (cmoney."日投信明細與排行") and 自營 net are a documented follow-up — they
 * fill trust_net / dealer_net, which are 0 for now. Market must be TWSE/TPEX;
 * NASDAQ/NYSE return empty because this DB is TW-only.
 *
 * Swap target named in stock-data.ts since the project started ("customer-db").
 */
import type {
  StockDataSource,
  MarketSnapshot,
  DailyQuote,
  InstitutionalFlow,
  Market,
} from './stock-data.ts';

const METABASE_DB_ID = 10;

export class MetabaseStockDataSource implements StockDataSource {
  readonly name = 'metabase';
  private readonly url: string;
  private readonly user: string;
  private readonly pass: string;
  private token: string | null = null;

  constructor() {
    const url = process.env.METABASE_URL;
    const user = process.env.METABASE_USER;
    const pass = process.env.METABASE_PASS;
    if (!url || !user || !pass) {
      throw new Error(
        'metabase stock source needs METABASE_URL / METABASE_USER / METABASE_PASS ' +
        'in env. Dot-source the sinopac-metabase skill setup first:\n' +
        '  . C:\\Users\\012701\\.claude\\skills\\sinopac-metabase\\scripts\\setup.ps1',
      );
    }
    this.url = url.replace(/\/+$/, '');
    this.user = user;
    this.pass = pass;
  }

  private async session(): Promise<string> {
    if (this.token) return this.token;
    const res = await fetch(`${this.url}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.user, password: this.pass }),
    });
    if (!res.ok) {
      throw new Error(`metabase /api/session ${res.status}: ${await res.text()}`);
    }
    const j = (await res.json()) as { id?: string };
    if (!j.id) throw new Error('metabase /api/session returned no session id');
    this.token = j.id;
    return this.token;
  }

  private async query(sql: string): Promise<{ cols: string[]; rows: unknown[][] }> {
    const token = await this.session();
    const res = await fetch(`${this.url}/api/dataset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Metabase-Session': token },
      body: JSON.stringify({
        database: METABASE_DB_ID,
        type: 'native',
        native: { query: sql },
      }),
    });
    if (!res.ok) {
      throw new Error(`metabase /api/dataset ${res.status}: ${await res.text()}`);
    }
    const j = (await res.json()) as {
      data?: { rows: unknown[][]; cols: { name: string }[] };
      error?: string;
    };
    if (j.error) throw new Error(`metabase query error: ${j.error}`);
    if (!j.data) throw new Error('metabase query returned no data block');
    return { cols: j.data.cols.map((c) => c.name), rows: j.data.rows };
  }

  async getDailySnapshot(market: Market, date: string): Promise<MarketSnapshot> {
    if (market !== 'TWSE' && market !== 'TPEX') {
      return { market, date, source: this.name, quotes: [] };
    }
    const sql =
      'SELECT "股票代號","股票名稱","開盤價","最高價","最低價","收盤價","漲跌",' +
      '"漲幅(%)","成交量(股)","成交筆數","成交金額(千)" ' +
      'FROM cmoney."日收盤表排行" ' +
      `WHERE toDate("日期") = '${date}' AND match("股票代號", '^[0-9]{4}$')`;
    const { cols, rows } = await this.query(sql);
    const at = (n: string) => cols.indexOf(n);
    const quotes: DailyQuote[] = [];
    for (const r of rows) {
      const close = num(r[at('收盤價')]);
      const change = num(r[at('漲跌')]);
      quotes.push({
        ticker: String(r[at('股票代號')]),
        name: String(r[at('股票名稱')]),
        date,
        open: num(r[at('開盤價')]),
        high: num(r[at('最高價')]),
        low: num(r[at('最低價')]),
        close,
        prev_close: close - change,
        change,
        change_pct: num(r[at('漲幅(%)')]),
        volume: num(r[at('成交量(股)')]),
        trades: num(r[at('成交筆數')]),
        turnover: num(r[at('成交金額(千)')]) * 1000,
      });
    }
    return { market, date, source: this.name, quotes };
  }

  async getInstitutionalFlow(market: Market, date: string): Promise<InstitutionalFlow[]> {
    if (market !== 'TWSE' && market !== 'TPEX') return [];
    // JOIN the price table for 成交量(股) so we can compute net_intensity
    // (net shares / day volume) — the signal the heat-score institutional
    // component actually uses. 外資買賣超 is in 張 (lots); ×1000 → shares, to
    // match volume's unit AND the InstitutionalFlow contract ("net ... shares").
    const sql =
      'SELECT f."股票代號" AS code, f."股票名稱" AS nm, f."外資買賣超" AS net_lots, ' +
      'p."成交量(股)" AS vol ' +
      'FROM cmoney."日外資持股與排行" AS f ' +
      'LEFT JOIN cmoney."日收盤表排行" AS p ' +
      '  ON f."股票代號" = p."股票代號" AND toDate(f."日期") = toDate(p."日期") ' +
      `WHERE toDate(f."日期") = '${date}' AND match(f."股票代號", '^[0-9]{4}$')`;
    const { cols, rows } = await this.query(sql);
    const at = (n: string) => cols.indexOf(n);
    const flows: InstitutionalFlow[] = [];
    for (const r of rows) {
      const netShares = num(r[at('net_lots')]) * 1000; // 張 → 股
      const vol = num(r[at('vol')]);
      flows.push({
        ticker: String(r[at('code')]),
        name: String(r[at('nm')]),
        date,
        foreign_net: netShares,
        trust_net: 0, // v1: 投信 net not wired yet (cmoney."日投信明細與排行")
        dealer_net: 0, // v1: 自營 net not wired yet
        total_net: netShares,
        net_intensity: vol > 0 ? netShares / vol : 0, // signed: net 股 / 成交股數
      });
    }
    return flows;
  }
}

/** Parse a Metabase cell to number; NaN / null / "NaN" → 0. */
function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}
