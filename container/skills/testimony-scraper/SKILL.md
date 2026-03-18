---
name: testimony-scraper
description: Manage the Hawaii Legislature testimony scraper. Use for checking status, restarting, or diagnosing the scraper at /workspace/shared/scrapers/legislature-testimony/.
allowed-tools: Bash
---

# Testimony Scraper

Scraper location: `/workspace/shared/scrapers/legislature-testimony/`
Log: `/workspace/shared/scrapers/legislature-testimony/claude_scraper.log`
DB: `/workspace/shared/scrapers/legislature-testimony/testimony_metadata.db`
Heartbeat: `/workspace/shared/scrapers/legislature-testimony/scraper.heartbeat`

## CRITICAL: Auth

**Always use `CLAUDECODE=""` when starting the scraper.** This forces the Claude CLI subprocess to use the `CLAUDE_CODE_OAUTH_TOKEN` from `/workspace/shared/.env`. Without it, the env var is unset by Claude Code's shell and you'll get 502 Bad Gateway errors on every PDF.

**Never use `ANTHROPIC_API_KEY` directly** — the OAuth token (`sk-ant-oat01-...`) is not a valid API key and will be rejected.

## Check Status

```bash
# Is it running?
ps aux | grep scrape_with_claude | grep -v grep

# What's it doing?
tail -20 /workspace/shared/scrapers/legislature-testimony/claude_scraper.log

# When did the heartbeat last update?
stat /workspace/shared/scrapers/legislature-testimony/scraper.heartbeat | grep Modify
```

If heartbeat is >45 min old, the scraper has stalled.

## Restart Scraper

```bash
# Kill any existing processes
kill $(ps aux | grep scrape_with_claude | grep -v grep | awk '{print $2}') 2>/dev/null
sleep 2

# Start with OAuth auth
cd /workspace/shared/scrapers/legislature-testimony && CLAUDECODE="" nohup python3 scrape_with_claude.py --year 2026 >> claude_scraper.log 2>&1 &
echo "Started PID: $!"
```

Then verify it's running and writing to the log after ~30 seconds.

## If Stuck on a Specific PDF

If the scraper hangs on a large PDF (>5MB), mark it as skipped in the DB:

```python
import sqlite3
conn = sqlite3.connect('/workspace/shared/scrapers/legislature-testimony/testimony_metadata.db')
conn.execute("""INSERT OR REPLACE INTO processed_pdfs (pdf_url, status, testifier_count)
VALUES ('<full_pdf_url>', 'skipped', 0)""")
conn.commit()
conn.close()
```

The `already_scraped()` function checks `processed_pdfs` with status `skipped/done/processed` and will skip it on the next run.

## Common Issues

- **502 Bad Gateway on every PDF** → Missing OAuth token. Restart with `CLAUDECODE=""`.
- **Stuck on large PDF (>5MB)** → Mark as skipped in DB, restart.
- **Log not updating** → Output may be buffered. Restart with `python3 -u` or check if process is alive with `ps aux`.
- **Duplicate processes** → Kill all, restart once.
- **`already_scraped` not skipping** → `testifiers` table stores `measure_full` without spaces (e.g. `HB1937` not `HB 1937`). The fixed `already_scraped()` handles both formats and also checks `processed_pdfs`.
