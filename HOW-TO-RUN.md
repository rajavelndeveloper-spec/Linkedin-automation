# How to run — step by step

Quick status check first: your `.env` file exists but `CRM_ENRICH_API_URL` and
`CRM_ENRICH_API_TOKEN` need to be filled in — that'll block steps 2+ below. The Chrome profile
directory at `D:/chrome-profiles/enrich-linkedin` existing is good, but only you can verify from
the actual browser window whether the login itself completed.

Here's the full step-by-step, in order:

## Step 0 — Confirm LinkedIn login actually completed
If you're not sure you finished logging in, redo this (safe to re-run — it just reopens the same
profile):
```
node -e "const { chromium } = require('playwright'); (async () => { const ctx = await chromium.launchPersistentContext('D:/chrome-profiles/enrich-linkedin', { channel: 'chrome', headless: false }); const page = ctx.pages()[0] || await ctx.newPage(); await page.goto('https://www.linkedin.com/feed/'); })();"
```
If it opens straight to your LinkedIn feed (not a login page), you're good — close the window.

## Step 1 — Fill in `.env`
Open `.env` and set:
```
CRM_ENRICH_API_URL=https://your-directus-host.com
CRM_ENRICH_API_TOKEN=your-directus-bearer-token
```
(No `/items/...` suffix on the URL — the tools append that.) Save the file.

## Step 2 — Test the fetch (no browser needed)
```
node tools/crm-leads-fetch.js --limit 5
```
Expect `"error": null` and a `leads` array. If you get an error, note exactly what it says.

## Step 3 — Test the scraper against one real URL
Copy a `job_posting_url` (or a `lead_source_description.source_urls` entry) from step 2's output,
then:
```
node tools/linkedin-enrich-scrape.js --url "PASTE_THE_URL_HERE" --hops profile,company
```
Expect `"session_expired": false` and `main_text`/`poster` populated. A visible Chrome window
will pop up and navigate — that's expected, it's not headless.

## Step 4 — Dry-run a PATCH (no real write)
Grab a lead `id` (a UUID) from step 2's output, then:
```
echo {"description":"test enrichment note"} | node tools/crm-leads-update.js --id PASTE_LEAD_ID_HERE --dry-run
```
Expect it to print the target URL and body back at you — nothing actually sent yet.

## Step 5 — Full flow, small and for real
```
opencode run --command enrich "limit=2" --auto
```
Note the message syntax is `limit=2`, not `--limit 2` — `opencode run`'s own argument parser
intercepts any message token starting with `--` before it reaches the command at all (that's
exactly what happened if you tried `--limit 2` and got `opencode run`'s own help text printed
back instead of a real run).

This really fetches, scrapes, reasons, and PATCHes up to 2 leads. Watch the terminal output — it
should end with a `RUN_RESULT: {...}` line. Then check those 2 leads directly in Directus to
confirm the enrichment looks right and nothing got regressed to `"not available"`.

Run these one at a time and note whichever step something looks off — that's the one to debug
first before moving on.
