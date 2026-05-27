/**
 * News data source adapter — single contract for fetching finance news.
 * Sister of `stock-data.ts`. Swap implementations (mock → real RSS / scraping
 * / vendor feed) by adding a new class behind `resolveNewsSource(name)`.
 *
 * Current implementations:
 *   - 'mock' — deterministic simulated news, no network calls (default).
 *
 * Planned:
 *   - 'cnyes-rss' — 鉅亨網 RSS
 *   - 'commercial-times-rss' — 工商時報 RSS
 *   - 'customer-feed' — your internal news feed
 *
 * What the handler does with this output: runs `wikify()` from
 * `entities/ticker-aliases.ts` over each article body so naked company
 * names become `[[tickers/XXXX]]` wikilinks before the markdown lands on
 * disk. This is what makes the graph self-wire on `gbrain sync`.
 */

export interface NewsArticle {
  /** Unique article id from the upstream source. Used for idempotency.
   *  Mock generator uses `mock-<date>-<index>`. */
  id: string;
  /** Publication time (ISO 8601 UTC). */
  published_at: string;
  /** Source label, e.g. 'mock', 'cnyes', 'commercial-times'. */
  source: string;
  /** Headline. */
  title: string;
  /** Body paragraphs (markdown-formatted, may contain naked company names). */
  body: string;
  /** Optional URL to the original article. Empty for mock. */
  url?: string;
  /** Hint from the source about which tickers/themes are relevant.
   *  Wikification still scans the body — this is a fallback only. */
  hint_tickers?: string[];
  hint_themes?: string[];
}

export interface NewsSource {
  readonly name: string;
  /** Returns articles published on the given date. Implementations may
   *  ignore future dates and return empty. */
  getArticles(date: string): Promise<NewsArticle[]>;
}

export interface ResolveNewsOpts {
  brain_dir: string;
}

export async function resolveNewsSource(
  name: string,
  opts: ResolveNewsOpts,
): Promise<NewsSource> {
  switch (name) {
    case 'mock': {
      const mod = await import('./mock-news-data.ts');
      return new mod.MockNewsSource(opts);
    }
    case 'stock-news-skill': {
      const mod = await import('./stock-news-skill-news-data.ts');
      return new mod.StockNewsSkillNewsSource(opts);
    }
    case 'user-research': {
      const mod = await import('./user-research-news-data.ts');
      return new mod.UserResearchNewsSource(opts);
    }
    default:
      throw new Error(
        `Unknown news source "${name}". Valid: mock, stock-news-skill, user-research. ` +
        `To add a real source, drop a new file in src/core/data-sources/ ` +
        `that implements NewsSource and register it here.`,
      );
  }
}
