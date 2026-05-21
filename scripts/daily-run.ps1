# daily-run.ps1 — one-command daily pipeline for Sino-StockBrain (Windows / PowerShell).
#
# Runs: rss-news-fetch (per source) -> news-ingest -> market-heat -> sync.
# Uses `gbrain jobs submit --follow`, which on PGLite runs inline (no worker
# daemon needed). On Postgres, start `gbrain jobs work` separately first.
#
# Usage:
#   .\scripts\daily-run.ps1                 # today, sources from config
#   .\scripts\daily-run.ps1 2026-05-20      # specific date
#
# RSS sources: edit config\news-sources.txt (one "name|url" per line, # = comment).
# Without that file, the fetch step is skipped and news-ingest reads whatever
# already sits in news-raw\<date>\ (e.g. from your local stock-news-skill).

param(
  [string]$Date = (Get-Date -Format "yyyy-MM-dd")
)

$ErrorActionPreference = "Stop"
$BrainDir = (Get-Location).Path
$SourcesFile = "config\news-sources.txt"

# Use global `gbrain` if installed, else `bun run src/cli.ts`.
if (Get-Command gbrain -ErrorAction SilentlyContinue) {
  $Gbrain = "gbrain"
} else {
  $Gbrain = "bun run src/cli.ts"
}

Write-Host "==================================================="
Write-Host "  Sino-StockBrain daily run"
Write-Host "  brain_dir: $BrainDir"
Write-Host "  date:      $Date"
Write-Host "  gbrain:    $Gbrain"
Write-Host "==================================================="

# Helper: submit a job with a hashtable -> JSON params (avoids manual escaping).
function Submit-Job($name, $params) {
  $json = ($params | ConvertTo-Json -Compress)
  Write-Host ">>> $name"
  Invoke-Expression "$Gbrain jobs submit $name --follow --params '$json'"
}

# -- Stage 1: fetch RSS news (per configured source) --
if (Test-Path $SourcesFile) {
  foreach ($line in Get-Content $SourcesFile) {
    $line = $line.Trim()
    if ($line -eq "" -or $line.StartsWith("#")) { continue }
    $parts = $line -split '\|', 2
    if ($parts.Count -lt 2) { continue }
    $name = $parts[0].Trim()
    $url = $parts[1].Trim()
    Submit-Job "rss-news-fetch" @{
      brain_dir   = $BrainDir
      source_name = $name
      rss_url     = $url
      date        = $Date
    }
  }
} else {
  Write-Host ">>> no $SourcesFile - skipping RSS fetch"
  Write-Host "    (news-ingest will read existing news-raw\$Date\ - e.g. from your local skill)"
}

# -- Stage 2: normalise + wikify --
Submit-Job "news-ingest" @{
  brain_dir = $BrainDir
  date      = $Date
  source    = "stock-news-skill"
}

# -- Stage 3: heat score --
Submit-Job "market-heat" @{
  brain_dir = $BrainDir
  date      = $Date
}

# -- Stage 4: ingest markdown into the brain DB --
Write-Host ">>> sync"
Invoke-Expression "$Gbrain sync"

Write-Host ""
Write-Host "==================================================="
Write-Host "  Done. Heat report: playbooks\heat\$Date.md"
Write-Host ""
Write-Host "  Next (manual):"
Write-Host "    1. Write / review digest -> playbooks\digests\$Date.md"
Write-Host "    2. Compliance gate (see docs\LOCAL_SETUP_WINDOWS.md)"
Write-Host "    3. git add tickers/ sectors/ themes/ playbooks/digests/ client-prep/"
Write-Host "       git commit -m 'digest $Date'; git push origin master"
Write-Host "==================================================="
