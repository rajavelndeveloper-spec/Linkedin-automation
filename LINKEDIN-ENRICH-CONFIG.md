# LinkedIn lead enrichment defaults

## Input format

`/enrich [date=YYYY-MM-DD] [limit=N]` — space-separated, both optional, override only the named
setting. **Never a leading `--`** in the invocation message itself — `opencode run`'s own CLI
argument parser intercepts any message token starting with `--` before the command ever sees it
(confirmed: `opencode run --command enrich "--limit 2" --auto` fails with `opencode run`'s own
usage/help text, not this command's logic). `tools/crm-leads-fetch.js`'s own `--date`/`--limit`
flags are unaffected by this — that collision only exists at the `opencode run` message layer,
never for a plain Node script invoked from inside an agent's own `bash` call.

| Setting | Default |
|---|---|
| Fetch window | Today — the UTC calendar day the run actually executes on, computed fresh each time (`date_created >= <today>T00:00:00.000Z AND date_created < <tomorrow>T00:00:00.000Z`, Directus's system field). Pass `--date YYYY-MM-DD` to reprocess a specific past day instead — never hardcode a date for a scheduled run |
| Fetch filter | `is_ai_generated = true` — this flow only enriches AI-generated leads, never a human-entered row |
| Max leads per run | Unlimited (`--limit -1`, Directus's own "no cap" value — matches the dashboard's default for this exact filter). Pass a positive `--limit` only to bound a test run |
| Max lead batch (concurrency) | 5 leads' worth of `lead-url-enrich` invocations in flight at once — same discipline as `linkedin-verify`'s batching in the sibling `ai-automation-system` project, to avoid two agents fighting over one browser session |
| Max URLs tried per lead | 3 — `job_posting_url` first (if present), then the lead's own `linkedin` column (if different — it can hold a post URL just as easily as a resolved profile, and is scraped the same as any other candidate; never written back regardless), then the first unseen entry in `lead_source_description.source_urls`. Stop at the first URL that yields real new evidence; try the next only if the previous one came back empty or `extraction_uncertain` |
| Navigation hops | `profile,company` — after the source URL, also load the poster's (or, for a resolved reshare, the original poster's) profile page (plus its Contact info overlay) and the company's **About tab specifically** (never the Home tab — forced by `toCompanyAboutUrl`, since About is where company facts actually render). When the source is a **post** that carries no direct `/company/` link but embeds a "View job" card, the `company` hop first opens that embedded job page once to read the company link off it (`job_page` in the tool output), then loads the About tab from there — the same company facts a job source URL yields directly. Pass `--hops ""` to `tools/linkedin-enrich-scrape.js` for a single-page-only run if account risk needs to be dialed back |
| Max page loads per URL attempt | 5 (source + embedded-job page *for a post that needs it* + profile main + profile Contact info overlay + company About tab) — bounded by which hops `tools/linkedin-enrich-scrape.js` runs, not agent reasoning. A job or company source URL never uses the embedded-job load, so those cap at 4 |
| Allowed PATCH fields | See `schemas/crm_leads_enrich_mapping.sql` — enforced inside `tools/crm-leads-update.js`'s `ALLOWED_TOP_KEYS`, not agent reasoning |
| Fetch runner | `./tools/crm-leads-fetch.js` |
| Enrich-scrape runner | `./tools/linkedin-enrich-scrape.js` (Playwright, authenticated session — see `LINKEDIN-ENRICH-Workflow.md`) |
| Update runner | `./tools/crm-leads-update.js` |
| Idempotency ledger runner | `./tools/processed-leads-ledger.js` — checked once per run (before dispatching any lead) and recorded once per lead (immediately after that lead's own terminal step, never batched) |
| Idempotency ledger file | `./state/processed-leads.json` (gitignored, atomic-written) — see `LINKEDIN-ENRICH-Workflow.md`'s Idempotency section for exactly what counts as "already done" |
| Chrome profile | `D:/chrome-profiles/enrich-linkedin` (override with `LINKEDIN_CHROME_PROFILE`) — its own dedicated persistent profile, created by the one-time manual login in `README.md`'s LinkedIn login section and reused automatically on every later run. A persistent Playwright context locks its profile directory, so never point two concurrently-running projects at the same path |
| Failure email notification | Enabled |
| PATCH response log | `./logs/crm-leads-enrich-responses.md` (gitignored) — human-readable table, one row per attempt, no payload body |
| PATCH payload log | `./logs/crm-leads-enrich-payloads.json` (gitignored, a JSON array — read-modify-write, rewritten atomically) — one element per real PATCH holding the exact request body sent, a UTC `logged_at` plus resolved-local `date`/`time`/`timezone`, the target row, `fields`/`dropped_keys`, and the outcome. Written automatically by `tools/crm-leads-update.js`; never on `--dry-run`. Defaults alongside the response log; override with `--payload-log <path>` |
| Notification log | `./logs/enrich-notifications.md` (gitignored) |
| Time zone | Runtime system time zone |

There is no output-path setting and no local-file delivery target — every
enriched fact is written straight back onto the existing `crm_leads` row via
`PATCH /items/crm_leads/{id}` (see `LINKEDIN-ENRICH-Workflow.md`'s Delivery
section). The required `CRM_ENRICH_API_URL`/`CRM_ENRICH_API_TOKEN` values come
from environment variables (OS/shell level, set once per machine, not per
run — a `.env` file is an optional supplement, never a requirement), same
convention as everything else here — see the root [`README.md`](README.md)
and [`.env.example`](.env.example).

`Enrich-scrape runner` and `Update runner` are execution configuration, not
API payload fields. Resolve relative runner paths from the directory
containing this file. `crm-leads-patch.md` must compare `Update runner`
against the live PATCH contract in `LINKEDIN-ENRICH-Workflow.md` before first
use each run and update that exact script in place on a material mismatch —
never create a second script.

Command arguments override only the settings they name. Behavior, evidence,
merge, and delivery rules are in `LINKEDIN-ENRICH-Workflow.md`.
