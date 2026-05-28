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
 * 法人 = 外資 + 投信. 自營 (dealer) is deliberately EXCLUDED — it's mostly
 * hedging / market-making noise. total_net = foreign + trust; dealer_net is
 * always 0; net_intensity = total_net / volume.
 *
 * 投信 caveat: cmoney."日投信明細與排行" 投信買賣超 is ALL-投信 (active selection
 * + passive ETF 申購買回). For 金融股 / 0050 / ETF components the number is
 * dominated by index rebalancing, not manager conviction (tell: 投信買均價 ==
 * 投信賣均價). The data itself is CORRECT — 張 × 均價 reconciles to 金額 to the
 * cent — just interpret 權值股 with care. The flow snapshot body carries this
 * caveat so downstream readers see it.
 *
 * No 4-way JOIN (ClickHouse times out on the full universe): 外資+收盤 is the
 * base query, 投信 is a cheap single-table date-filtered query merged in JS by
 * 股票代號. Market must be TWSE/TPEX; NASDAQ/NYSE return empty (TW-only DB).
 *
 * Swap target named in stock-data.ts since the project started ("customer-db").
 */
import type {
  StockDataSource,
  MarketSnapshot,
  DailyQuote,
  InstitutionalFlow,
  MonthlyRevenue,
  ConsensusEPS,
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
    // Three legs, three single-table queries merged in JS (faster than ClickHouse
    // JOIN over 1900+ tickers). All `*買賣超` columns are in 張 (lots), ×1000
    // → shares to match the InstitutionalFlow contract.
    //
    // 自營 (dealer): we use 「自行買賣」 ONLY — not the combined `自營商買賣超`.
    // The combined number folds in 避險 (option/warrant market-making hedge
    // flow), which is structurally large and reactive to derivatives positions
    // not directional bets — that's why the old impl dropped dealer entirely.
    // 自行買賣 is the real proprietary bet leg and IS a signal worth keeping.
    const foreignSql =
      'SELECT f."股票代號" AS code, f."股票名稱" AS nm, f."外資買賣超" AS net_lots, ' +
      'p."成交量(股)" AS vol ' +
      'FROM cmoney."日外資持股與排行" AS f ' +
      'LEFT JOIN cmoney."日收盤表排行" AS p ' +
      '  ON f."股票代號" = p."股票代號" AND toDate(f."日期") = toDate(p."日期") ' +
      `WHERE toDate(f."日期") = '${date}' AND match(f."股票代號", '^[0-9]{4}$')`;
    const trustSql =
      'SELECT "股票代號" AS code, "投信買賣超" AS net_lots ' +
      'FROM cmoney."日投信明細與排行" ' +
      `WHERE toDate("日期") = '${date}' AND match("股票代號", '^[0-9]{4}$')`;
    const dealerSql =
      'SELECT "股票代號" AS code, "自營商買賣超(自行買賣)" AS net_lots ' +
      'FROM cmoney."日自營商進出排行" ' +
      `WHERE toDate("日期") = '${date}' AND match("股票代號", '^[0-9]{4}$')`;

    const [foreignRes, trustRes, dealerRes] = await Promise.all([
      this.query(foreignSql),
      this.query(trustSql),
      this.query(dealerSql),
    ]);

    const trustByCode = lotsToSharesMap(trustRes);
    const dealerByCode = lotsToSharesMap(dealerRes);

    const at = (n: string) => foreignRes.cols.indexOf(n);
    const flows: InstitutionalFlow[] = [];
    for (const r of foreignRes.rows) {
      const code = String(r[at('code')]);
      const foreignShares = Math.round(num(r[at('net_lots')]) * 1000);
      const trustShares = trustByCode.get(code) ?? 0;
      const dealerShares = dealerByCode.get(code) ?? 0; // 自行買賣 only
      const totalShares = foreignShares + trustShares + dealerShares;
      const vol = num(r[at('vol')]);
      flows.push({
        ticker: code,
        name: String(r[at('nm')]),
        date,
        foreign_net: foreignShares,
        trust_net: trustShares,
        dealer_net: dealerShares,
        total_net: totalShares,
        net_intensity: vol > 0 ? totalShares / vol : 0, // signed: 三大法人 net 股 / 成交股數
      });
    }
    return flows;
  }

  async getMonthlyRevenue(market: Market, yearMonth?: string): Promise<MonthlyRevenue[]> {
    if (market !== 'TWSE' && market !== 'TPEX') return [];
    const T = 'cmoney."月營收(成長與達成率)"';
    // Resolve the latest available 年月 unless the caller pinned one. 月營收
    // lags the trading calendar (published ~10th of the following month), so
    // "latest" is the only safe default — never assume it matches a price date.
    let ym = yearMonth;
    if (!ym) {
      const r = await this.query(`SELECT max("年月") AS ym FROM ${T}`);
      ym = r.rows.length && r.rows[0]![0] != null ? String(r.rows[0]![0]) : '';
      if (!ym) return [];
    }
    if (!/^\d{6}$/.test(ym)) throw new Error(`getMonthlyRevenue: bad year_month "${ym}" (want YYYYMM)`);
    const sql =
      'SELECT "股票代號" AS code, "股票名稱" AS nm, "年月" AS ym, ' +
      '"單月合併營收(千)" AS rev, "單月合併營收年成長(%)" AS yoy, ' +
      '"單月合併營收月變動(%)" AS mom, "累計合併營收(千)" AS cum, ' +
      '"累計合併營收成長(%)" AS cum_yoy, "近12月累計合併營收(千)" AS ttm, ' +
      '"近12月營收合併成長(%)" AS ttm_yoy, "近三月合併營收年成長(%)" AS q_yoy, ' +
      'toString("公告日") AS ann ' +
      `FROM ${T} ` +
      `WHERE "年月" = '${ym}' AND match("股票代號", '^[0-9]{4}$')`;
    const { cols, rows } = await this.query(sql);
    const at = (n: string) => cols.indexOf(n);
    const out: MonthlyRevenue[] = [];
    for (const r of rows) {
      out.push({
        ticker: String(r[at('code')]),
        name: String(r[at('nm')]),
        year_month: String(r[at('ym')]),
        revenue: Math.round(num(r[at('rev')]) * 1000), // 千 → 元
        yoy_pct: num(r[at('yoy')]),
        mom_pct: num(r[at('mom')]),
        cum_revenue: Math.round(num(r[at('cum')]) * 1000),
        cum_yoy_pct: num(r[at('cum_yoy')]),
        ttm_revenue: Math.round(num(r[at('ttm')]) * 1000),
        ttm_yoy_pct: num(r[at('ttm_yoy')]),
        three_month_yoy_pct: num(r[at('q_yoy')]),
        announce_date: String(r[at('ann')]).slice(0, 10),
      });
    }
    return out;
  }

  async getLatestQuoteDate(market: Market): Promise<string | null> {
    if (market !== 'TWSE' && market !== 'TPEX') return null;
    const r = await this.query('SELECT toString(max("日期")) AS d FROM cmoney."日收盤表排行"');
    if (!r.rows.length || r.rows[0]![0] == null) return null;
    return String(r.rows[0]![0]).slice(0, 10);
  }

  async getConsensusEPS(market: Market, yearMonth?: string): Promise<ConsensusEPS[]> {
    if (market !== 'TWSE' && market !== 'TPEX') return [];
    const T = 'cmoney."月機構預估盈餘與EPS"';
    let ym = yearMonth;
    if (!ym) {
      const r = await this.query(`SELECT max("年月") AS ym FROM ${T}`);
      ym = r.rows.length && r.rows[0]![0] != null ? String(r.rows[0]![0]) : '';
      if (!ym) return [];
    }
    if (!/^\d{6}$/.test(ym)) throw new Error(`getConsensusEPS: bad year_month "${ym}" (want YYYYMM)`);
    const sql =
      'SELECT "股票代號" AS code, "股票名稱" AS nm, "年月" AS ym, ' +
      '"累計近四季EPS" AS ttm, "機構估稅後EPS(元)" AS cy, "明年機構估稅後EPS" AS ny, ' +
      '"預估年稅後EPS成長(%)" AS cy_g, "預測機構數" AS ac, "明年預測機構數" AS ac_n, ' +
      '"最高本益比" AS pe_h, "最低本益比" AS pe_l, toString("更新日") AS upd ' +
      `FROM ${T} ` +
      `WHERE "年月" = '${ym}' AND match("股票代號", '^[0-9]{4}$')`;
    const { cols, rows } = await this.query(sql);
    const at = (n: string) => cols.indexOf(n);
    const out: ConsensusEPS[] = [];
    for (const r of rows) {
      const cy = numOrNull(r[at('cy')]);
      const ny = numOrNull(r[at('ny')]);
      // Headline metric: next-year growth vs current-year. Null when either
      // side missing or current_year <= 0 (loss-makers skew the ratio).
      const nyg = cy != null && ny != null && cy > 0 ? ((ny - cy) / cy) * 100 : null;
      out.push({
        ticker: String(r[at('code')]),
        name: String(r[at('nm')]),
        year_month: String(r[at('ym')]),
        ttm_eps: numOrNull(r[at('ttm')]),
        current_year_eps: cy,
        next_year_eps: ny,
        current_year_growth_pct: numOrNull(r[at('cy_g')]),
        next_year_growth_pct: nyg,
        analyst_count: numOrNull(r[at('ac')]),
        analyst_count_next: numOrNull(r[at('ac_n')]),
        pe_high: numOrNull(r[at('pe_h')]),
        pe_low: numOrNull(r[at('pe_l')]),
        updated_date: String(r[at('upd')]).slice(0, 10),
      });
    }
    return out;
  }
}

/** Parse a Metabase cell to number; NaN / null / "NaN" → 0. */
function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

/** Same as `num`, but distinguishes missing data from a real zero by returning
 *  null. Use for fields where 0 has analytical meaning (EPS estimates: a real
 *  0 EPS is a different signal from "no analyst covers"). */
function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === 'nan') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** Build 股票代號 → net shares map from a (code, net_lots) result, converting
 *  張 → 股 (×1000). Used to merge 投信 / 自營 net into the 外資-driven base. */
function lotsToSharesMap(res: { cols: string[]; rows: unknown[][] }): Map<string, number> {
  const codeIdx = res.cols.indexOf('code');
  const lotsIdx = res.cols.indexOf('net_lots');
  const m = new Map<string, number>();
  for (const r of res.rows) {
    m.set(String(r[codeIdx]), Math.round(num(r[lotsIdx]) * 1000));
  }
  return m;
}
