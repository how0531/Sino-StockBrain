/**
 * Unit tests for the RSS 2.0 parser (src/core/data-sources/rss-parse.ts).
 *
 * Pure functions over strings + a committed XML fixture. No network, no env
 * mutation, no PGLite — safe for the parallel fast loop.
 */

import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseRss,
  extractTag,
  unwrapCdata,
  stripHtml,
  decodeEntities,
  pubDateToIso,
  pubDateToTaipeiDate,
  deriveArticleId,
  type RssItem,
} from '../src/core/data-sources/rss-parse.ts';

const FIXTURE = readFileSync(
  resolve(__dirname, 'fixtures/rss/cnyes-tw-stock-sample.xml'),
  'utf8',
);

// ===========================================================================
// parseRss against the real-shape fixture
// ===========================================================================

describe('parseRss', () => {
  test('parses all 4 items from the fixture', () => {
    const items = parseRss(FIXTURE);
    expect(items).toHaveLength(4);
  });

  test('unwraps CDATA in title + description', () => {
    const items = parseRss(FIXTURE);
    const first = items[0]!;
    expect(first.title).toBe('國巨MLCC報價傳調漲 車用拉貨潮再起');
    expect(first.title).not.toContain('CDATA');
    expect(first.description).toContain('國巨');
    expect(first.description).not.toContain('CDATA');
  });

  test('strips HTML tags from description (naked body)', () => {
    const items = parseRss(FIXTURE);
    const first = items[0]!;
    expect(first.description).not.toContain('<p>');
    expect(first.description).not.toContain('</p>');
    expect(first.description).toContain('被動元件龍頭國巨');
  });

  test('handles non-CDATA plain text items', () => {
    const items = parseRss(FIXTURE);
    const largan = items.find((i) => i.title.includes('大立光'))!;
    expect(largan).toBeDefined();
    expect(largan.description).toContain('iPhone');
  });

  test('extracts link + guid + pubDate', () => {
    const items = parseRss(FIXTURE);
    const first = items[0]!;
    expect(first.link).toBe('https://news.example-finance.com/news/id/5483921');
    expect(first.guid).toBe('5483921');
    expect(first.pubDate).toContain('20 May 2026');
  });

  test('returns empty array for non-RSS input', () => {
    expect(parseRss('not xml')).toEqual([]);
    expect(parseRss('<html><body>nope</body></html>')).toEqual([]);
    expect(parseRss('')).toEqual([]);
  });

  test('skips items missing a title', () => {
    const xml = `<rss><channel>
      <item><link>https://x.com/1</link><description>no title</description></item>
      <item><title>has title</title></item>
    </channel></rss>`;
    const items = parseRss(xml);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('has title');
  });
});

// ===========================================================================
// extractTag / unwrapCdata
// ===========================================================================

describe('extractTag', () => {
  test('extracts simple tag', () => {
    expect(extractTag('<title>hello</title>', 'title')).toBe('hello');
  });
  test('unwraps CDATA', () => {
    expect(extractTag('<title><![CDATA[hi]]></title>', 'title')).toBe('hi');
  });
  test('handles tag attributes', () => {
    expect(extractTag('<guid isPermaLink="false">123</guid>', 'guid')).toBe('123');
  });
  test('returns empty for missing tag', () => {
    expect(extractTag('<other>x</other>', 'title')).toBe('');
  });
});

describe('unwrapCdata', () => {
  test('unwraps', () => {
    expect(unwrapCdata('<![CDATA[content]]>')).toBe('content');
  });
  test('passthrough non-CDATA', () => {
    expect(unwrapCdata('plain')).toBe('plain');
  });
  test('handles surrounding whitespace', () => {
    expect(unwrapCdata('  <![CDATA[x]]>  ')).toBe('x');
  });
});

// ===========================================================================
// stripHtml / decodeEntities
// ===========================================================================

describe('stripHtml', () => {
  test('removes tags', () => {
    expect(stripHtml('<p>hello <b>world</b></p>')).toBe('hello world');
  });
  test('converts <br> and </p> to newlines', () => {
    expect(stripHtml('a<br/>b')).toContain('\n');
  });
  test('collapses excess whitespace', () => {
    expect(stripHtml('a    b')).toBe('a b');
  });
});

describe('decodeEntities', () => {
  test('decodes named entities', () => {
    expect(decodeEntities('a &amp; b &lt; c &gt; d')).toBe('a & b < c > d');
  });
  test('decodes numeric entities', () => {
    expect(decodeEntities('&#65;&#66;')).toBe('AB');
  });
  test('decodes hex entities', () => {
    expect(decodeEntities('&#x41;')).toBe('A');
  });
  test('decodes nbsp to space', () => {
    expect(decodeEntities('a&nbsp;b')).toBe('a b');
  });
});

// ===========================================================================
// pubDate handling
// ===========================================================================

describe('pubDateToIso', () => {
  test('parses RFC-822 to ISO', () => {
    const iso = pubDateToIso('Wed, 20 May 2026 08:30:00 +0800');
    expect(iso).toMatch(/^2026-05-20T00:30:00/); // 08:30 +0800 = 00:30 UTC
  });
  test('falls back to now on unparseable', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(pubDateToIso('garbage', now)).toBe(now.toISOString());
  });
  test('empty falls back to now', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(pubDateToIso('', now)).toBe(now.toISOString());
  });
});

describe('pubDateToTaipeiDate', () => {
  test('derives TPE date', () => {
    expect(pubDateToTaipeiDate('Wed, 20 May 2026 08:30:00 +0800')).toBe('2026-05-20');
  });
  test('UTC near midnight rolls into correct TPE day', () => {
    // 2026-05-19 17:00 UTC = 2026-05-20 01:00 TPE
    expect(pubDateToTaipeiDate('Tue, 19 May 2026 17:00:00 +0000')).toBe('2026-05-20');
  });
});

// ===========================================================================
// deriveArticleId
// ===========================================================================

describe('deriveArticleId', () => {
  const item = (over: Partial<RssItem>): RssItem => ({
    title: 't', link: '', description: 'd', pubDate: '', guid: '', ...over,
  });

  test('uses numeric trailing id from guid', () => {
    expect(deriveArticleId(item({ guid: '5483921' }))).toBe('5483921');
  });
  test('extracts numeric id from link path', () => {
    expect(deriveArticleId(item({ link: 'https://x.com/news/id/5483921' }))).toBe('5483921');
  });
  test('slugifies non-numeric last segment', () => {
    expect(deriveArticleId(item({ link: 'https://x.com/article/some-slug' }))).toBe('some-slug');
  });
  test('hashes title when no id source', () => {
    const id = deriveArticleId(item({ title: 'unique title' }));
    expect(id).toMatch(/^h[0-9a-f]+$/);
  });
  test('deterministic for same title', () => {
    const a = deriveArticleId(item({ title: 'same' }));
    const b = deriveArticleId(item({ title: 'same' }));
    expect(a).toBe(b);
  });
});
