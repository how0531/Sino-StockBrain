---
name: stock-news-skill
version: 0.1.0
description: |
  Fetch finance news from upstream sources (RSS, web scrapers, vendor APIs),
  normalise to the schema-v1 raw JSON format, write to
  <brain_dir>/news-raw/<date>/<source>-<id>.json. Downstream `news-ingest`
  handler wikifies + writes to news/<date>/*.md.
triggers:
  - "抓今天的財經新聞"
  - "fetch finance news"
  - "stock news"
  - "rss pull"
  - "新聞抓取"
tools:
  - WebFetch
  - WebSearch
mutating: true
writes_pages:
  - news-raw/<date>/<source>-<id>.json
---

# Stock News Skill — Finance News Collector

This skill's job is **only** to fetch raw news from upstream sources and write
schema-conformant JSON. It does NOT wikify, NOT dedup across days, NOT format
for downstream consumption — those steps belong to the `news-ingest` handler.

## Contract

This skill guarantees:
- Output is valid JSON conforming to schema version 1 (see below)
- One file per article at the documented path
- Files are atomic-write (write to .tmp then rename) to avoid partial reads
- Same `article_id` is never re-written (idempotent — skip if exists)
- All required string fields are non-empty
- Best-effort writes — failure to fetch one source never blocks others

## Output Schema (v1) — REQUIRED FORMAT

Write each article to:

```
<brain_dir>/news-raw/<YYYY-MM-DD>/<source>-<article_id>.json
```

File content:

```json
{
  "schema_version": 1,
  "article_id": "cnyes-5483921",
  "source_name": "cnyes",
  "published_at": "2026-05-20T08:30:00+08:00",
  "title": "MLCC報價傳調漲，車用拉貨潮再起",
  "body": "被動元件龍頭國巨近期傳出對車用 MLCC 客戶開出新一輪報價...",
  "url": "https://news.cnyes.com/news/id/5483921",
  "hint_tickers": ["2327", "2492", "2456"],
  "hint_themes": ["passive-components"],
  "fetched_at": "2026-05-20T08:32:15+08:00"
}
```

### Field rules

| Field | Type | Required | Notes |
|---|---|---|---|
| `schema_version` | `1` | yes | Bump only when shape changes |
| `article_id` | string | yes | Stable per upstream source. Use upstream's article number |
| `source_name` | string | yes | `cnyes`, `commercial-times`, `economic-daily`, `bloomberg-tw`, etc. |
| `published_at` | ISO 8601 string | yes | Prefer TPE offset `+08:00` |
| `title` | string | yes | Naked text, no markdown |
| `body` | string | yes | Naked text. **NO wikify here** — downstream wikifies based on alias map |
| `url` | string | no | Original URL, useful for citation |
| `hint_tickers` | string[] | no | Optional fast-path. Use upstream's tagged tickers if available |
| `hint_themes` | string[] | no | Optional. e.g. `["passive-components", "ai-infrastructure"]` |
| `raw_html` | string | no | Keep if your re-extraction pipeline needs it |
| `fetched_at` | ISO 8601 string | no | When YOU fetched it |

### Filename convention

`<source_name>-<article_id>.json` — guarantees no collision across sources
even if they share article numbers.

Examples:
- `cnyes-5483921.json`
- `commercial-times-news_arr_2026052012345.json`
- `ltn-3543210.json`

## Phases

### Phase 1: Discover targets

Decide which upstream sources to pull today. Operator config typically lists:

- `cnyes.com` — RSS at `https://news.cnyes.com/rss/cat/tw_stock`
- `chinatimes.com 工商` — RSS at `https://ctee.com.tw/feed`
- `udn.com 經濟日報` — search archives
- ...whichever your subscription/legal access allows

Read this list from `<brain_dir>/config/news-sources.yml` if it exists,
else fall back to your skill's hardcoded default.

### Phase 2: Fetch + parse

For each source:
1. Pull the feed/page
2. For each item, extract title + body + published_at + URL
3. **DO NOT wikify** — body stays as naked Chinese / English text
4. Optionally enrich `hint_tickers` from any upstream tagging
5. Skip articles published outside the target date window

### Phase 3: Write

For each parsed article:
1. Compute filename: `<source_name>-<article_id>.json`
2. Compute target path: `<brain_dir>/news-raw/<published_date>/<filename>`
3. If file exists, SKIP (idempotent)
4. Else: atomic write (`.tmp` + rename)

### Phase 4: Trigger downstream (optional)

When done, OPTIONALLY submit a `news-ingest` job to process today's batch:

```bash
gbrain jobs submit news-ingest \
  --params "{\"brain_dir\":\"$BRAIN_DIR\",\"date\":\"$DATE\",\"source\":\"stock-news-skill\"}"
```

Without this trigger, the next scheduled `news-ingest` run picks up the files
automatically.

## Compliance Boundary

This skill is a **sense layer** — it must NOT:

- Filter articles by "should we publish this?"
- Add buy/sell language to body
- Inject editorial commentary
- Dedup across sources (let the wikify-dedup pipeline handle that)

It must:

- Be transparent: write what the source said, don't paraphrase
- Be auditable: include `url` whenever possible
- Be respectful: rate-limit fetches per upstream's robots.txt and TOS

The `compliance-filter` handler is downstream from this skill. Its job is to
gate **output to clients**, not raw news collection. Your output may be
inflammatory, opinionated, or speculative — that's the upstream source's
voice, and the downstream pipeline contextualises it.

## Integration

This skill is wired to the project via:

1. **NewsSource adapter** at `src/core/data-sources/stock-news-skill-news-data.ts`
   — reads your JSON and exposes it as a `NewsSource` to handlers
2. **News-ingest handler** runs with `--params '{"source":"stock-news-skill"}'`
   — pulls articles from your output, wikifies, writes to `news/<date>/*.md`
3. **Downstream auto-wires**:
   - `gbrain sync` extracts entity refs → page graph
   - `market-heat` reads `news/<date>/_summary.md` mention counts
   - `daily-market-digest` cites real articles in the daily report
   - `compliance-filter` gates the digest before client push

You don't need to touch any handler code. Your skill writes JSON; the
adapter handles the rest.

## When NOT to use this skill

- One-off article ingest → write a single `.md` directly to `news/<date>/`
- Already-formatted brain pages → use `gbrain put_page` directly
- Email-based input → use `skills/email-ingest/SKILL.md`
- Social media monitoring → use `recipes/x-to-brain.md`

## Filing Rules

See `skills/_brain-filing-rules.md`. This skill writes to:

- `news-raw/<YYYY-MM-DD>/<source>-<id>.json` — raw JSON, db_only, gitignored

Does NOT write to `news/`, `tickers/`, or any other path. Downstream
pipeline owns those.

## Testing your skill

Fixtures + assertions: drop a sample article into
`test/fixtures/stock-news-skill/2026-05-20/` and run the adapter test:

```bash
bun test test/stock-news-skill-adapter.test.ts
```

The adapter validates the shape; if your output fails, you'll see exactly
which field is malformed.
