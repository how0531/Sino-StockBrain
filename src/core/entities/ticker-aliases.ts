/**
 * Ticker alias map + wikify — the deterministic name-to-slug resolver for
 * stock-domain pages. Sits BESIDE `src/core/entities/resolve.ts` — this file is
 * the stock-specific layer because we have a (now market-wide) alias list and
 * want sub-millisecond lookups before any DB call.
 *
 * Two key sources, merged at module load:
 *   1. `ticker-master.json` — AUTO-GENERATED from the company Metabase
 *      (`cmoney."上市櫃公司基本資料"`) by `scripts/gen-stock-master.py`. ~1976
 *      listed TWSE+TPEX stocks: code -> {name, abbr, en, market, industry}.
 *      This is what makes wikify catch ~any listed company name in real news.
 *   2. Hand-curated overrides below — the watchlist core + US tickers (NOT in
 *      the TW master) + well-known English aliases (TSMC / Foxconn / Yageo).
 *      Curated rows WIN on key collisions (applied last).
 *
 * Short-name guard (user requirement "全上市櫃 + 短名護欄"): 2-character CJK
 * names that are ALSO common Chinese words (統一 / 大同 / 中華 …) are dropped
 * from the auto-wikify key set — otherwise "統一發票" / "大同小異" would mint
 * bogus ticker edges. They stay reachable via the news source's code tagging
 * (news-ingest hint_tickers path). Distinctive 2-char names (鴻海 / 國巨 / 台塑)
 * still link. `AMBIGUOUS_SHORT_NAMES` is curatable — grow it when a false
 * positive shows up in playbooks/violations or graph spot-checks.
 *
 * Why deterministic before LLM: layer 1 (this file) handles the vast majority
 * for ~$0; layer 2 (Haiku) is reserved for the long tail in news-ingest.
 *
 * Limitations (documented, not bugs):
 *   - CJK has no word boundaries, so name matching is longest-match-first and
 *     ordering-dependent (defeats "國" eating the inside of "國巨").
 *   - English ticker / alias matching is word-boundary-safe (`\bNVDA\b`).
 *   - We deliberately DO NOT load the master's English abbreviations (英文簡稱,
 *     e.g. "YYS" / "ECS") as keys — 2-4 letter codes false-match English prose.
 */

import tickerMasterRaw from './ticker-master.json';

export interface TickerAlias {
  ticker: string; // canonical ticker code, e.g. "2327"
  name: string; // canonical display name in zh-TW
  exchange: 'TWSE' | 'TPEX' | 'NASDAQ' | 'NYSE';
}

interface TickerMasterRow {
  name: string;
  abbr: string;
  en: string;
  market: string;
  industry: string;
}

const TICKER_MASTER = tickerMasterRaw as Record<string, TickerMasterRow>;

/** 2-char CJK names that double as common words/idioms. Dropped from the
 *  auto-wikify key set to avoid false ticker edges. Curatable — add offenders
 *  as they surface. Only affects MASTER-derived names; curated rows below are
 *  never filtered. */
const AMBIGUOUS_SHORT_NAMES: ReadonlySet<string> = new Set([
  '統一', '大同', '中華', '第一', '台灣', '中國', '國際', '全國',
  '中央', '國產', '上海', '大成', '中興', '國票', '大眾', '世界',
  '全球', '國家', '第二', '中信', '台北', '南港', '大將', '國防',
]);

/** cmoney 上市上櫃 code -> gbrain exchange label. 1=上市, 2=上櫃. */
function marketToExchange(market: string): TickerAlias['exchange'] {
  return market === '2' ? 'TPEX' : 'TWSE';
}

/** Master alias map. Keys are recognised name/ticker tokens (case-insensitive
 *  for English, exact-match for CJK). */
export const TICKER_ALIASES: Record<string, TickerAlias> = (() => {
  const map: Record<string, TickerAlias> = Object.create(null);

  const add = (key: string, row: TickerAlias) => {
    const k = key.trim();
    if (k) map[k] = row;
  };

  // ---- Layer 1: market-wide master (TWSE + TPEX) ----
  for (const [code, m] of Object.entries(TICKER_MASTER)) {
    const row: TickerAlias = {
      ticker: code,
      name: m.name,
      exchange: marketToExchange(m.market),
    };
    // Deliberately DO NOT register the bare numeric code as a key — 4-digit TW
    // codes collide with years (2025=千興, 2027=大成鋼), prices (2230=泰茂) and
    // phone digits (8299=群聯) everywhere in Chinese news. Link by NAME only; the
    // name virtually always appears (the code usually sits in parens beside it).
    for (const surface of [m.name, m.abbr]) {
      const s = surface.trim();
      if (!s) continue;
      // Short-name guard: skip ambiguous 2-char common words.
      if (s.length === 2 && AMBIGUOUS_SHORT_NAMES.has(s)) continue;
      add(s, row);
    }
  }

  // ---- Layer 2: hand-curated overrides (win on collision) ----
  const curated: TickerAlias[] = [
    // Taiwan watchlist core
    { ticker: '2330', name: '台積電', exchange: 'TWSE' },
    { ticker: '2317', name: '鴻海', exchange: 'TWSE' },
    { ticker: '2454', name: '聯發科', exchange: 'TWSE' },
    { ticker: '2308', name: '台達電', exchange: 'TWSE' },
    { ticker: '3008', name: '大立光', exchange: 'TWSE' },
    // 被動元件 watchlist
    { ticker: '2327', name: '國巨', exchange: 'TWSE' },
    { ticker: '2492', name: '華新科', exchange: 'TWSE' },
    { ticker: '2456', name: '奇力新', exchange: 'TWSE' },
    { ticker: '2375', name: '智寶', exchange: 'TWSE' },
    { ticker: '3026', name: '禾伸堂', exchange: 'TWSE' },
    { ticker: '3090', name: '日電貿', exchange: 'TWSE' },
    // US core (NOT in the TW master — must stay hand-curated)
    { ticker: 'NVDA', name: 'NVIDIA', exchange: 'NASDAQ' },
    { ticker: 'AAPL', name: 'Apple', exchange: 'NASDAQ' },
    { ticker: 'MSFT', name: 'Microsoft', exchange: 'NASDAQ' },
    { ticker: 'GOOGL', name: 'Alphabet', exchange: 'NASDAQ' },
    { ticker: 'TSLA', name: 'Tesla', exchange: 'NASDAQ' },
  ];
  for (const e of curated) {
    // Only alpha codes (US: NVDA/AAPL/…) are safe as bare keys; numeric TW codes
    // collide with years/prices/phones (see master-loop note above).
    if (!/^\d+$/.test(e.ticker)) add(e.ticker, e);
    add(e.name, e);
  }

  // Well-known English aliases (the master's 英文簡稱 is too noisy to load
  // wholesale, so we curate the ones worth matching in English prose).
  const enAlias = (key: string, ticker: string) => {
    const row = curated.find((r) => r.ticker === ticker);
    if (row) add(key, row);
  };
  enAlias('TSMC', '2330');
  enAlias('Foxconn', '2317');
  enAlias('Hon Hai', '2317');
  enAlias('MediaTek', '2454');
  enAlias('Delta', '2308');
  enAlias('Largan', '3008');
  enAlias('Yageo', '2327');
  enAlias('Walsin', '2492');
  enAlias('Chilisin', '2456');
  enAlias('Capxon', '2375');
  enAlias('Holy Stone', '3026');

  return map;
})();

/** Precompiled match plan, sorted longest-key-first (once at module load — the
 *  hot wikify path must not re-sort or re-compile per article across the ~2k
 *  key set). Reusing global-flag RegExps across String.replace calls is safe;
 *  replace does not depend on lastIndex. */
interface CompiledAlias {
  re: RegExp;
  ticker: string;
  slug: string;
}
const COMPILED: CompiledAlias[] = Object.keys(TICKER_ALIASES)
  .sort((a, b) => b.length - a.length)
  .map((key) => {
    const alias = TICKER_ALIASES[key]!;
    const isAscii = /^[A-Za-z0-9 ]+$/.test(key);
    const re = isAscii
      ? new RegExp(`\\b${escapeRegExp(key)}\\b`, /^\d+$/.test(key) ? 'g' : 'gi')
      : new RegExp(escapeRegExp(key), 'g');
    return { re, ticker: key === alias.ticker ? alias.ticker : key, slug: alias.ticker.toLowerCase() };
  });

export interface WikifyStats {
  matched: Map<string, number>;
  total_replacements: number;
}

export interface WikifyResult {
  text: string;
  stats: WikifyStats;
}

/** Pure: rewrite raw text so every recognised ticker / name surface form
 *  becomes a `[[tickers/<slug>]]` wikilink. Used by news-ingest before writing
 *  to disk. Idempotent — existing wikilinks are masked out, so running twice
 *  produces identical output. */
export function wikify(text: string): WikifyResult {
  const stats: WikifyStats = { matched: new Map(), total_replacements: 0 };

  // Tokenizer mask. Each masked span becomes <n> (Private Use Area
  // chars — never appear in news prose or alias keys, so no key regex can match
  // inside a token). CRITICAL: we mask BOTH pre-existing wikilinks (idempotency)
  // AND every NEW link we create in the loop below — otherwise a shorter alias
  // (e.g. 聯發/1459) matches the surface form inside a longer link we just made
  // (聯發科/2454), producing nested garbage.
  const tokens: string[] = [];
  const mask = (s: string): string => {
    const tok = `${tokens.length}`;
    tokens.push(s);
    return tok;
  };

  let masked = text.replace(/\[\[[^\]]+\]\]/g, (m) => mask(m));

  for (const { re, slug } of COMPILED) {
    masked = masked.replace(re, (match) => {
      stats.total_replacements++;
      stats.matched.set(slug, (stats.matched.get(slug) ?? 0) + 1);
      // Append the surface form in parens only when it differs from the bare
      // code ("[[tickers/2327]] (國巨)" helps; "[[tickers/2330]] (2330)" is noise).
      const link =
        match === slug.toUpperCase() || match === slug
          ? `[[tickers/${slug}]]`
          : `[[tickers/${slug}]] (${match})`;
      return mask(link);
    });
  }

  // Restore every masked span (final strings — no nested tokens, single pass).
  const out = masked.replace(/(\d+)/g, (_, idx) => tokens[Number(idx)]!);
  return { text: out, stats };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
