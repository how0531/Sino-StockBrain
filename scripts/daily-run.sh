#!/usr/bin/env bash
#
# daily-run.sh — one-command daily pipeline for Sino-StockBrain.
#
# Runs: rss-news-fetch (per source) → news-ingest → market-heat → sync.
# Uses `gbrain jobs submit --follow`, which on PGLite runs inline (no worker
# daemon needed). On Postgres, start `gbrain jobs work` separately first.
#
# Usage:
#   bash scripts/daily-run.sh                 # today, sources from config
#   bash scripts/daily-run.sh 2026-05-20      # specific date
#
# RSS sources: edit config/news-sources.txt (one "name|url" per line, # = comment).
# Without that file, the news-fetch step is skipped and news-ingest reads
# whatever already sits in news-raw/<date>/ (e.g. from your local
# stock-news-skill).
#
set -euo pipefail

BRAIN_DIR="$(pwd)"
DATE="${1:-$(date +%F)}"
SOURCES_FILE="config/news-sources.txt"

# Use the global `gbrain` if installed, else fall back to `bun run src/cli.ts`.
if command -v gbrain >/dev/null 2>&1; then
  GBRAIN="gbrain"
else
  GBRAIN="bun run src/cli.ts"
fi

echo "═══════════════════════════════════════════════════"
echo "  Sino-StockBrain daily run"
echo "  brain_dir: $BRAIN_DIR"
echo "  date:      $DATE"
echo "  gbrain:    $GBRAIN"
echo "═══════════════════════════════════════════════════"

# ── Stage 1: fetch RSS news (per configured source) ──────────────────────
if [[ -f "$SOURCES_FILE" ]]; then
  while IFS='|' read -r name url; do
    # skip blanks + comments
    [[ -z "${name// }" || "${name#\#}" != "$name" ]] && continue
    name="$(echo "$name" | xargs)"
    url="$(echo "$url" | xargs)"
    echo ">>> rss-news-fetch: $name"
    $GBRAIN jobs submit rss-news-fetch --follow \
      --params "{\"brain_dir\":\"$BRAIN_DIR\",\"source_name\":\"$name\",\"rss_url\":\"$url\",\"date\":\"$DATE\"}"
  done < "$SOURCES_FILE"
else
  echo ">>> no $SOURCES_FILE — skipping RSS fetch"
  echo "    (news-ingest will read existing news-raw/$DATE/ — e.g. from your local skill)"
fi

# ── Stage 2: normalise + wikify ───────────────────────────────────────────
echo ">>> news-ingest"
$GBRAIN jobs submit news-ingest --follow \
  --params "{\"brain_dir\":\"$BRAIN_DIR\",\"date\":\"$DATE\",\"source\":\"stock-news-skill\"}"

# ── Stage 3: heat score ───────────────────────────────────────────────────
echo ">>> market-heat"
$GBRAIN jobs submit market-heat --follow \
  --params "{\"brain_dir\":\"$BRAIN_DIR\",\"date\":\"$DATE\"}"

# ── Stage 4: ingest markdown into the brain DB ────────────────────────────
echo ">>> sync"
$GBRAIN sync

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Done. Heat report: playbooks/heat/$DATE.md"
echo ""
echo "  Next (manual):"
echo "    1. Write / review digest → playbooks/digests/$DATE.md"
echo "    2. Compliance gate:"
echo "       $GBRAIN jobs submit compliance-filter --follow \\"
echo "         --params '{\"brain_dir\":\"$BRAIN_DIR\",\"date\":\"$DATE\",\"llm\":true}'"
echo "    3. Commit knowledge (bulk data auto-ignored):"
echo "       git add tickers/ sectors/ themes/ playbooks/digests/ client-prep/"
echo "       git commit -m 'digest $DATE' && git push origin master"
echo "═══════════════════════════════════════════════════"
