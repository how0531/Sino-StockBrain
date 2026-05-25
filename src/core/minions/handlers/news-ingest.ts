/**
 * `news-ingest` job handler.
 *
 * Pulls finance news through the `NewsSource` adapter, runs `wikify()` over
 * each article body so naked company names become `[[tickers/XXXX]]`
 * wikilinks, and writes one markdown file per article under
 * `<brain_dir>/news/<YYYY-MM-DD>/<slug>.md`.
 *
 * Why this is the graph's secret weapon: once the article body is wikified,
 * `gbrain sync`'s auto-link extractor (link-extraction.ts) finds every
 * `[[tickers/2327]]` reference, writes a `mentions` edge from the news
 * page to the ticker page, and (if missing) creates the ticker page stub.
 * No LLM call, no schema migration, the network grows itself.
 *
 * Mock vs real: defaults to `source=mock`. When you connect a real RSS
 * feed (cnyes, commercial-times, vendor), add an adapter to
 * `src/core/data-sources/` and a case in `resolveNewsSource()`.
 *
 * LLM-assisted resolution (path-2): a `--params '{"rewriter":"llm"}'` flag
 * is reserved for the next iteration. Path-1 (deterministic alias map)
 * lands here. The alias map at `src/core/entities/ticker-aliases.ts`
 * covers ~95% of cases the demo needs.
 *
 * Trust model: NOT in PROTECTED_JOB_NAMES — no LLM cost yet, no RCE
 * surface (read-only adapter call + disk write inside brain_dir).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MinionJobContext } from '../types.ts';
import { UnrecoverableError } from '../types.ts';
import type { NewsArticle } from '../../data-sources/news-data.ts';
import { resolveNewsSource } from '../../data-sources/news-data.ts';
import { wikify } from '../../entities/ticker-aliases.ts';

export interface NewsIngestParams {
  brain_dir: string;
  date?: string;
  source?: string;
  /** Reserved for next iteration: 'alias-map' (default) | 'llm'. */
  rewriter?: string;
}

export interface NewsIngestResult {
  status: 'ok' | 'skipped';
  reason?: string;
  date: string;
  source: string;
  rewriter: string;
  articles_fetched: number;
  articles_written: number;
  total_wikify_replacements: number;
  output_dir: string;
  /** Aggregate ticker → mention-count across all articles written this run.
   *  Useful for spot-checking the wikify pass and for downstream salience. */
  ticker_mentions: Record<string, number>;
}

export async function newsIngestHandler(
  ctx: MinionJobContext,
): Promise<NewsIngestResult> {
  const params = validateParams(ctx.data);
  const date = resolveDate(params.date ?? 'today');
  const sourceName = params.source ?? 'mock';
  const rewriter = params.rewriter ?? 'alias-map';

  if (rewriter !== 'alias-map') {
    // LLM rewriter not wired yet — reserved for next iteration. Fail loud
    // rather than silently running with a different code path.
    throw new UnrecoverableError(
      `news-ingest: rewriter "${rewriter}" not implemented yet. ` +
      `Use rewriter="alias-map" (default) or omit the param.`,
    );
  }

  const outputDir = join(params.brain_dir, 'news', date);
  mkdirSync(outputDir, { recursive: true });

  await ctx.log(
    `[news-ingest] source=${sourceName} date=${date} rewriter=${rewriter}`,
  );

  const newsSource = await resolveNewsSource(sourceName, {
    brain_dir: params.brain_dir,
  });
  const articles = await newsSource.getArticles(date);

  let written = 0;
  let totalReplacements = 0;
  const tickerMentions: Record<string, number> = {};

  for (const article of articles) {
    if (ctx.signal.aborted) throw new Error('aborted');

    const slug = articleSlug(article);
    const filePath = join(outputDir, `${slug}.md`);
    if (existsSync(filePath)) continue;

    // Strip the 投顧 / disclaimer / APP-ad tail before wikify so broker
    // self-mentions (永豐金證券, 凱基投顧…) and "免責聲明" boilerplate names
    // don't mint ticker edges.
    const cleanBody = stripDisclaimerTail(article.body);
    const wikifiedTitle = wikify(article.title);
    const wikifiedBody = wikify(cleanBody);

    // Distinct tickers this article touches (title + body wikify ∪ hint codes).
    const distinct = new Set<string>();
    for (const [t] of wikifiedTitle.stats.matched) distinct.add(t);
    for (const [t] of wikifiedBody.stats.matched) distinct.add(t);
    const hintSlugs: string[] = [];
    for (const raw of article.hint_tickers ?? []) {
      const s = raw.trim().toLowerCase();
      if (!s || !/^[a-z0-9]+$/.test(s)) continue;
      if (!hintSlugs.includes(s)) hintSlugs.push(s);
      distinct.add(s);
    }

    // Fan-out cap: a list / market-summary / multi-stock tout ("今日漲停50檔",
    // "三大法人買超TOP", "投顧精選30檔") co-mentions many unrelated stocks — that
    // co-mention is NOT a relationship signal. Write the page plain (no
    // wikilinks → no edges) and skip its mention stats (so news-density heat
    // isn't pumped by listicles). The page stays searchable; it just doesn't
    // pollute the graph with spurious adjacency.
    const isBroad = distinct.size > FANOUT_CAP;

    let titleOut: string;
    let bodyOut: string;
    if (isBroad) {
      titleOut = article.title;
      bodyOut = cleanBody;
    } else {
      totalReplacements += wikifiedTitle.stats.total_replacements;
      totalReplacements += wikifiedBody.stats.total_replacements;
      const matched = new Set<string>();
      for (const [t, c] of wikifiedTitle.stats.matched) {
        tickerMentions[t] = (tickerMentions[t] ?? 0) + c;
        matched.add(t);
      }
      for (const [t, c] of wikifiedBody.stats.matched) {
        tickerMentions[t] = (tickerMentions[t] ?? 0) + c;
        matched.add(t);
      }
      // hint_tickers (#3): author-tagged codes the alias map may have missed.
      const hintAdd = hintSlugs.filter((s) => !matched.has(s));
      for (const s of hintAdd) tickerMentions[s] = (tickerMentions[s] ?? 0) + 1;
      titleOut = wikifiedTitle.text;
      bodyOut =
        wikifiedBody.text +
        (hintAdd.length > 0
          ? '\n\n相關個股：' + hintAdd.map((s) => `[[tickers/${s}]]`).join(' ')
          : '');
    }

    writeFileSync(
      filePath,
      renderArticleMarkdown(article, titleOut, bodyOut, date, isBroad),
      'utf8',
    );
    written++;
  }

  // Per-day summary — Top mentioned tickers for the day.
  const summaryPath = join(outputDir, '_summary.md');
  writeFileSync(
    summaryPath,
    renderSummary(articles, written, tickerMentions, date, sourceName),
    'utf8',
  );

  await ctx.log(
    `[news-ingest] wrote ${written}/${articles.length} articles, ` +
    `${totalReplacements} wikify replacements across ` +
    `${Object.keys(tickerMentions).length} unique tickers`,
  );

  return {
    status: 'ok',
    date,
    source: sourceName,
    rewriter,
    articles_fetched: articles.length,
    articles_written: written,
    total_wikify_replacements: totalReplacements,
    output_dir: outputDir,
    ticker_mentions: tickerMentions,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function validateParams(data: Record<string, unknown>): NewsIngestParams {
  if (typeof data.brain_dir !== 'string' || !data.brain_dir) {
    throw new UnrecoverableError('news-ingest: missing required param "brain_dir"');
  }
  if (data.date !== undefined && typeof data.date !== 'string') {
    throw new UnrecoverableError('news-ingest: "date" must be a string');
  }
  if (data.source !== undefined && typeof data.source !== 'string') {
    throw new UnrecoverableError('news-ingest: "source" must be a string');
  }
  if (data.rewriter !== undefined && typeof data.rewriter !== 'string') {
    throw new UnrecoverableError('news-ingest: "rewriter" must be a string');
  }
  return {
    brain_dir: data.brain_dir,
    date: data.date as string | undefined,
    source: data.source as string | undefined,
    rewriter: data.rewriter as string | undefined,
  };
}

function resolveDate(input: string): string {
  if (input === 'today') {
    const tw = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const y = tw.getFullYear();
    const m = String(tw.getMonth() + 1).padStart(2, '0');
    const d = String(tw.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    throw new UnrecoverableError(`news-ingest: invalid date "${input}"`);
  }
  return input;
}

/** Stable, filesystem-safe slug from article id. Mock ids are already safe. */
function articleSlug(article: NewsArticle): string {
  return article.id.replace(/[^a-zA-Z0-9_-]/g, '-');
}

/** Above this many distinct tickers, an article is a list / market-summary /
 *  multi-stock tout: written plain (no edges). Focused news names a handful. */
const FANOUT_CAP = 8;

/** Markers that open a 投顧 / disclaimer / APP-ad tail. Everything from the
 *  earliest match to end-of-body is dropped before wikify, so broker
 *  self-mentions and boilerplate names don't mint ticker edges. */
const DISCLAIMER_MARKERS: RegExp[] = [
  /免責聲明/,
  /※\s*免責/,
  /文章來源[：:]/,
  /本公司所推薦/,
  /投資人(應|請|須)(自行|獨立)/,
  /以往(之|的)?績效/,
  /自負(盈虧|投資?風險)/,
  /不(構成|代表)(任何)?(投資)?建議/,
  /立即(填表|下載|體驗|加入)/,
  /分析師\s*APP/,
  /錢進熱線/,
];

function stripDisclaimerTail(body: string): string {
  let cut = body.length;
  for (const re of DISCLAIMER_MARKERS) {
    const m = re.exec(body);
    if (m && m.index < cut) cut = m.index;
  }
  return cut < body.length ? body.slice(0, cut).trimEnd() : body;
}

function renderArticleMarkdown(
  article: NewsArticle,
  titleOut: string,
  bodyOut: string,
  date: string,
  isBroad: boolean,
): string {
  return `---
type: news_article
slug: news/${date}/${articleSlug(article)}
article_id: "${article.id}"
source: ${article.source}
published_at: ${article.published_at}
url: ${article.url ?? ''}
hint_tickers: ${formatYamlList(article.hint_tickers)}
hint_themes: ${formatYamlList(article.hint_themes)}
broad_listing: ${isBroad}
---

# ${titleOut}

${bodyOut}
`;
}

function renderSummary(
  articles: NewsArticle[],
  written: number,
  tickerMentions: Record<string, number>,
  date: string,
  sourceName: string,
): string {
  const ranked = Object.entries(tickerMentions)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  // Bare code only — NOT [[tickers/X]] AND NOT bare "tickers/X". gbrain's link
  // extractor matches a bare "tickers/X" path too (not just [[wikilinks]]), so
  // the prior plain-text form STILL cliqued the day's top-20 through the
  // _summary node. Dropping the "tickers/" prefix makes the digest readable but
  // truly edge-free. "Hot today" is carried by each ticker's own mention count,
  // not a 20-node summary clique. (Do NOT re-add the prefix.)
  const mentionLines = ranked
    .map(([t, n]) => `- ${t} — 提及 ${n} 次`)
    .join('\n');

  const articleLines = articles
    .map((a) => `- [[news/${date}/${articleSlug(a)}]] ${a.title}`)
    .join('\n');

  return `---
type: news_summary
slug: news/${date}/_summary
date: ${date}
source: ${sourceName}
articles_fetched: ${articles.length}
articles_written: ${written}
unique_tickers_mentioned: ${Object.keys(tickerMentions).length}
---

# 新聞 Summary — ${date}

- 抓取文章數：${articles.length}
- 寫入：${written}
- 涉及個股數：${Object.keys(tickerMentions).length}

## Top 提及個股

${mentionLines || '(empty)'}

## Articles

${articleLines || '(empty)'}
`;
}

function formatYamlList(items?: string[]): string {
  if (!items || items.length === 0) return '[]';
  return '[' + items.map((s) => `"${s}"`).join(', ') + ']';
}
