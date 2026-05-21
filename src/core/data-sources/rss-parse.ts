/**
 * RSS 2.0 parser — pure functions, no network. Turns an RSS XML string into
 * structured items. Used by the `rss-news-fetch` handler (which does the HTTP
 * + disk write around this).
 *
 * Why a hand-rolled parser, not an XML library:
 *   - RSS 2.0 item structure is simple + stable (title/link/description/
 *     pubDate/guid). A regex extractor over <item> blocks is sufficient and
 *     dependency-free (Bun has no built-in DOMParser).
 *   - We only need a handful of fields. A full XML DOM is overkill.
 *
 * Robustness contract:
 *   - Handles CDATA-wrapped content (`<![CDATA[...]]>`) — most zh-TW feeds
 *     wrap titles + descriptions this way.
 *   - Strips HTML tags from description to produce naked body text (wikify
 *     happens downstream; we don't want <p>/<a> tags in the brain page).
 *   - Decodes common HTML entities (&amp; &lt; &gt; &quot; &#NNN;).
 *   - Tolerates missing optional fields (link/guid/pubDate) — only title +
 *     description are required for a usable article.
 *
 * What it does NOT do: namespaced extensions (media:, dc:, content:encoded),
 * Atom feeds, RSS 1.0/RDF. Add those when a real feed needs them.
 */

export interface RssItem {
  title: string;
  link: string;
  description: string; // naked text, HTML stripped
  pubDate: string;     // raw RFC-822 string as-is (caller normalises)
  guid: string;        // upstream id (falls back to link)
}

/** Parse an RSS 2.0 XML string into items. Returns [] on unrecognised input. */
export function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemBlocks = xml.match(/<item\b[^>]*>([\s\S]*?)<\/item>/gi);
  if (!itemBlocks) return items;

  for (const block of itemBlocks) {
    const title = extractTag(block, 'title');
    const description = extractTag(block, 'description');
    // Require at least a title; skip empty shells.
    if (!title) continue;

    const link = extractTag(block, 'link');
    const guid = extractTag(block, 'guid');
    const pubDate = extractTag(block, 'pubDate');

    items.push({
      title: decodeEntities(title).trim(),
      link: link.trim(),
      description: stripHtml(decodeEntities(description)).trim(),
      pubDate: pubDate.trim(),
      guid: (guid || link).trim(),
    });
  }
  return items;
}

/** Extract the inner text of the first `<tag>...</tag>` in a block, unwrapping
 *  CDATA. Returns '' when the tag is absent. */
export function extractTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  if (!m) return '';
  return unwrapCdata(m[1] ?? '');
}

/** `<![CDATA[ x ]]>` → `x`. Passthrough when no CDATA wrapper. */
export function unwrapCdata(s: string): string {
  const m = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return m ? m[1]! : s;
}

/** Strip HTML tags, collapse whitespace. RSS descriptions are often HTML. */
export function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Decode the common HTML entities seen in zh-TW RSS feeds. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&nbsp;/g, ' ');
}

/** Best-effort: parse an RFC-822 pubDate to an ISO 8601 string. Falls back
 *  to `now` when unparseable so the article still lands somewhere. */
export function pubDateToIso(pubDate: string, now: Date = new Date()): string {
  if (!pubDate) return now.toISOString();
  const d = new Date(pubDate);
  if (Number.isNaN(d.getTime())) return now.toISOString();
  return d.toISOString();
}

/** Derive the YYYY-MM-DD bucket (Asia/Taipei) for an article. RSS pubDate is
 *  often in TPE already, but we normalise to be safe. */
export function pubDateToTaipeiDate(pubDate: string, now: Date = new Date()): string {
  const d = pubDate ? new Date(pubDate) : now;
  const valid = Number.isNaN(d.getTime()) ? now : d;
  const tpe = new Date(valid.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const y = tpe.getFullYear();
  const m = String(tpe.getMonth() + 1).padStart(2, '0');
  const day = String(tpe.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Derive a stable article_id from the guid or link. Strips URL noise so the
 *  filename is clean. Falls back to a hash of the title when both are absent. */
export function deriveArticleId(item: RssItem): string {
  const raw = item.guid || item.link;
  if (raw) {
    // Pull a trailing numeric id if present (e.g. .../news/id/5483921).
    const numeric = raw.match(/(\d{4,})(?:\.\w+)?$/);
    if (numeric) return numeric[1]!;
    // Else slugify the last path segment.
    const seg = raw.split(/[/?#]/).filter(Boolean).pop() ?? raw;
    return seg.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
  }
  // No id source — hash the title.
  return 'h' + fnv1a(item.title).toString(16);
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
