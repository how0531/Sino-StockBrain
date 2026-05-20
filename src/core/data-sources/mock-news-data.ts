/**
 * Mock news source — deterministic, plausible Taiwan finance news for
 * end-to-end testing the news ingest → wikify → graph pipeline.
 *
 * Design goals (mirroring mock-stock-data.ts):
 *   1. Deterministic per (date, index) so re-runs are reproducible.
 *   2. Statistical plausibility — articles span themes (passive components,
 *      AI infra, smartphone supply chain) and tones (price action, earnings
 *      call, analyst note, industry rumor).
 *   3. NAKED company names in the body. The whole point of the demo is to
 *      let `wikify()` turn raw text into graph-aware markdown.
 *
 * What this is NOT: a news aggregator. There is no real headline DB, no
 * actual market events. Headlines are templates with deterministic blanks.
 * Replace with a real source (cnyes RSS, Bloomberg, vendor feed) for
 * production decisions.
 */

import type { NewsArticle, NewsSource, ResolveNewsOpts } from './news-data.ts';

interface ArticleTemplate {
  theme: string;
  title: (vars: TemplateVars) => string;
  body: (vars: TemplateVars) => string;
  /** Tickers this template tends to mention — used by the hint field. */
  primary_tickers: string[];
}

interface TemplateVars {
  date: string;
  primary: string;        // primary company short name (e.g. "國巨")
  primary_ticker: string; // e.g. "2327"
  related: string;        // related company short name
  pct_move: string;       // e.g. "+3.2%"
  amount: string;         // e.g. "12.5 億"
}

/** Daily article count: ~5-8 articles per trading day. Realistic for a
 *  single sector focused brain, far below the 100s of articles a broad
 *  financial-news aggregator emits. */
const ARTICLES_PER_DAY = 6;

/** Article templates. Each template carries a theme tag for the hint
 *  field; the actual body uses BARE company names so the wikify pass has
 *  something to do. */
const TEMPLATES: ArticleTemplate[] = [
  {
    theme: 'passive-components',
    primary_tickers: ['2327', '2492', '2456', '2375', '3026'],
    title: (v) => `${v.primary} MLCC 報價傳調漲，車用拉貨潮再起`,
    body: (v) => `
被動元件龍頭${v.primary}近期傳出對車用 MLCC 客戶開出新一輪報價，漲幅約 ${v.pct_move}。
${v.related}、奇力新等同業亦傳跟進。

法人指出，歐美電動車與 ADAS 滲透率持續攀升，車用被動元件單機用量較消費性
產品高 3-5 倍，是這波報價調整的主因。${v.primary} 2024 年車用佔比已突破
30%，新台幣 ${v.amount}的車用訂單能見度延伸至下半年。

風險面，市場關注中國消費性 MLCC 庫存去化進度，以及 ${v.primary} 在工業類
應用的客戶集中度。
`.trim(),
  },
  {
    theme: 'passive-components',
    primary_tickers: ['3090'],
    title: (v) => `${v.primary} 法說會：被動元件下半年能見度提升`,
    body: (v) => `
通路商${v.primary}今日召開法說會，董事長表示被動元件下半年能見度較上半年明顯提升。
原廠如國巨、華新科對車用與工控需求拉貨積極，禾伸堂在高階 MLCC 報價維持強勢。

毛利率方面，${v.primary} Q2 自結毛利率 ${v.pct_move}，較去年同期回升。
存貨周轉天數降至 90 天以下，已脫離庫存高點。

法人提問聚焦在 AI server 用被動元件業務貢獻，公司表示與華新科、奇力新合作的
高頻電感模組業績已開始遞延入帳。
`.trim(),
  },
  {
    theme: 'ai-infrastructure',
    primary_tickers: ['2330', 'NVDA', '2308'],
    title: (v) => `外資連 3 日買超${v.primary}，看好 AI 需求遞延效應`,
    body: (v) => `
外資及陸資今日續站買方，買超${v.primary} ${v.amount}股，連續第 3 個交易日淨買超。
NVIDIA 上週法說會釋出 Blackwell 平台拉貨優於預期訊息，台積電作為唯一 4nm/3nm
代工廠直接受惠。

CoWoS 產能擴張進度方面，${v.primary}已將 2025 年月產能目標上修。台達電在 AI
伺服器電源市佔率約 50%，鴻海則拿下 GB200 機櫃組裝主要訂單。

外資目標價方面，多數券商維持「優於大盤」，目標價區間 ${v.amount}至 ${v.amount}元。
`.trim(),
  },
  {
    theme: 'smartphone-supply-chain',
    primary_tickers: ['3008', 'AAPL', '2317'],
    title: (v) => `${v.primary} 9 月營收創高，iPhone 拉貨優於預期`,
    body: (v) => `
${v.primary}公布 9 月合併營收${v.amount}億元，月增 ${v.pct_move}，創歷史新高。
Apple iPhone 新機備貨節奏較往年提前，潛望式長焦鏡頭良率穩定。

供應鏈方面，鴻海印度組裝廠 9 月出貨量已達 iPhone 15 全球出貨的 12%。
大立光車用鏡頭已切入歐系車廠 ADAS 平台，Q4 起貢獻營收。

法人預期 Q4 旺季效應與印度產能擴張，${v.primary} 全年 EPS 有機會挑戰 ${v.amount}元。
`.trim(),
  },
  {
    theme: 'ev',
    primary_tickers: ['TSLA', '2317'],
    title: (v) => `${v.primary} 中國市場 9 月銷售月增 ${v.pct_move}，BYD 競爭加劇`,
    body: (v) => `
Tesla 中國 9 月交車 ${v.amount}萬輛，月增 ${v.pct_move}。上海超級工廠出口至歐洲
比重提升。

競爭面，BYD 9 月 EV+PHEV 合計銷量再創高，純電車市佔率與 Tesla 差距持續縮小。
鴻海 MIH 平台新客戶簽約進度受市場關注。

技術面，Tesla FSD V13 在北美用戶端表現獲改善，但中國市場仍受監管限制。
`.trim(),
  },
  {
    theme: 'passive-components',
    primary_tickers: ['2492', '2456'],
    title: (v) => `${v.primary} 高頻電感切入 AI server 供應鏈，毛利率有望結構性提升`,
    body: (v) => `
${v.primary}證實已與 NVIDIA 認證供應商日電貿合作，高頻電感模組打入 GB200 AI
伺服器電源轉換階段。每張 GPU 板用量是消費性產品 5-8 倍。

毛利率方面，AI server 用高階電感毛利優於一般消費性 30-40 個百分點。
${v.primary} 預估 2025 年 AI 相關貢獻達整體營收 ${v.pct_move}。

風險：產能限制 — ${v.primary} 印尼新廠 Q4 投產，產能緩解仍需時間。
`.trim(),
  },
];

export class MockNewsSource implements NewsSource {
  readonly name = 'mock';
  private readonly brainDir: string;

  constructor(opts: ResolveNewsOpts) {
    this.brainDir = opts.brain_dir;
    void this.brainDir; // reserved for future per-brain config (e.g. tone)
  }

  async getArticles(date: string): Promise<NewsArticle[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    const dow = new Date(date + 'T08:00:00+08:00').getUTCDay();
    if (dow === 0 || dow === 6) return [];

    const out: NewsArticle[] = [];
    for (let i = 0; i < ARTICLES_PER_DAY; i++) {
      const rng = seededRng(`${date}:${i}`);
      const tmpl = TEMPLATES[Math.floor(rng() * TEMPLATES.length)]!;
      const vars = synthVars(tmpl, date, rng);
      out.push({
        id: `mock-${date}-${i}`,
        published_at: `${date}T${String(8 + i).padStart(2, '0')}:30:00+08:00`,
        source: this.name,
        title: tmpl.title(vars),
        body: tmpl.body(vars),
        hint_tickers: tmpl.primary_tickers,
        hint_themes: [tmpl.theme],
      });
    }
    return out;
  }
}

// ===========================================================================
// helpers (private)
// ===========================================================================

function synthVars(tmpl: ArticleTemplate, date: string, rng: () => number): TemplateVars {
  const primary = pickTickerName(tmpl.primary_tickers, rng);
  // Related: a different ticker from the same theme pool.
  const relatedPool = tmpl.primary_tickers.filter((t) => t !== primary.ticker);
  const related = relatedPool.length > 0
    ? pickTickerName(relatedPool, rng).name
    : '同業';
  return {
    date,
    primary: primary.name,
    primary_ticker: primary.ticker,
    related,
    pct_move: `${(rng() * 8 + 0.5).toFixed(1)}%`,
    amount: `${(rng() * 50 + 5).toFixed(1)}`,
  };
}

interface TickerName { ticker: string; name: string }

function pickTickerName(pool: string[], rng: () => number): TickerName {
  const ticker = pool[Math.floor(rng() * pool.length)]!;
  return { ticker, name: NAME_LOOKUP[ticker] ?? ticker };
}

const NAME_LOOKUP: Record<string, string> = {
  '2330': '台積電', '2317': '鴻海', '2454': '聯發科', '2308': '台達電',
  '3008': '大立光', '2327': '國巨',  '2492': '華新科', '2456': '奇力新',
  '2375': '智寶',   '3026': '禾伸堂', '3090': '日電貿',
  'NVDA': 'NVIDIA', 'AAPL': 'Apple', 'MSFT': 'Microsoft',
  'GOOGL': 'Alphabet', 'TSLA': 'Tesla',
};

// Same PRNG as mock-stock-data.ts — keep them parallel so future tests of
// "the brain on a given day" use one seed across both data sources.
function seededRng(key: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
