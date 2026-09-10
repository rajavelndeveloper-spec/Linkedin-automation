# LinkedIn lead enrichment workflow

Behavior, evidence, PATCH, and delivery rules for `/enrich`. `LINKEDIN-ENRICH-AGENT.md` is the
overall contract; `LINKEDIN-ENRICH-CONFIG.md` owns the changeable defaults this file refers to.

## 1. Fetch (once per run)

`enrich-orchestrator` resolves `--date`/`--limit` (defaults from
`LINKEDIN-ENRICH-CONFIG.md` — today's UTC calendar day, computed fresh at run time, and `-1` for
no cap) and runs exactly one command:

```bash
node tools/crm-leads-fetch.js --date <resolved> --limit <resolved>
```

Parse the JSON on stdout: `{ leads, count, fetched_at, date, filter, error }`.

- `error` non-null → the fetch itself failed (missing env vars, HTTP failure, etc.). This is a
  terminal run failure — report it in `RUN_RESULT` as `status: "failed"` and route to
  `email-notify`. Do not retry more than once.
- `count: 0` with no error is a legitimate, reportable outcome — there were no AI-generated leads
  created in the resolved window. This is a final-zero, not a failure (see Notification below).
- Never re-run the fetch to "fix" its shape or size — a re-fetch returns the same result the
  window and filter already determined; work with what came back.

## 2. Idempotency ledger (once per run, before dispatching any lead)

Immediately after a successful fetch, extract every fetched lead's `id` into a JSON array and run:

```bash
node tools/processed-leads-ledger.js --check
```
(the id array piped on stdin)

Parse `{ pending, skipped, error }`. `skipped` ids were already fully processed by a previous
run — **never invoke `lead-url-enrich` for them again**. This is the guard against an accidental
re-run (someone runs `/enrich` twice the same day, a scheduled task double-fires, etc.)
re-spending LinkedIn traffic and opencode/LLM cost on leads that are already done. Only `pending`
ids proceed to step 3. A ledger `error` (corrupt/unreadable file) is non-fatal — treat every lead
as `pending` rather than block the run; the ledger only prevents waste, it never gates progress.

**What counts as "already done" (decided inside the ledger tool, not by agent judgment)**: an
entry with `outcome: "no-new-data"` (nothing to patch, and the page hasn't changed since —
re-scraping would find the same nothing), or `outcome: "enriched"`/`"partial"` with
`commit_state: "confirmed"` (the diff that existed was actually saved). An entry with
`commit_state: "failed"`/`"unknown"`, or an `outcome` of `"session_expired"`/
`"selectors_suspect"`, is **not** terminal — that lead stays `pending` so the next run retries it
once the underlying problem (a lapsed session, a transient API failure) is actually fixed. This
is why a lead is recorded once per lead immediately after its own terminal step (step 4) rather
than batched to the end of the run: a crashed or interrupted run still preserves every lead it
did genuinely finish, and never records one it didn't.

The ledger (`state/processed-leads.json`, gitignored) is local run state, not CRM data — nothing
in it is ever sent to Directus. It is written atomically (temp file + rename) so a process killed
mid-write can't corrupt it.

## 3. Per-lead procedure (`lead-url-enrich`)

For each fetched lead, build the URL candidate list, in this order: `job_posting_url` (if
non-empty and not the literal `"not available"` sentinel), then the lead's own `linkedin` column
(same check, only if different from `job_posting_url`), then every entry of
`lead_source_description.source_urls` not already covered above, in the array's existing order.
Drop duplicates and empties. Try **at most 3 URLs total** (`LINKEDIN-ENRICH-CONFIG.md`).

**`linkedin` is a read-only source here, not a resolved-profile guarantee** — it can hold a post
URL just as easily as a person's profile, and it is included as a scrape candidate for exactly
that reason. `tools/linkedin-enrich-scrape.js` classifies whatever it's given by URL pattern
regardless of which lead field it came from, so a post found this way is handled identically to
one found via `source_urls`.

For the URL being tried:

```bash
node tools/linkedin-enrich-scrape.js --url "<url>" --hops profile,company
```

Parse the JSON on stdout: `{ url, type, main_text, poster, reposted_by, original_post,
company_link, links, profile_page, company_page, hops_done, extraction_uncertain,
session_expired, selectors_suspect, error, started_at, finished_at, duration_ms }`.

- `error` non-null or `session_expired: true` → treat as terminal for this lead's *this URL*
  attempt. `session_expired` takes precedence over `extraction_uncertain`/`selectors_suspect` and
  means the persistent Chrome profile's LinkedIn session has logged out — a human needs to
  re-authenticate it (see `README.md`'s LinkedIn login section), not a selector fix. Stop trying
  further URLs for *every remaining lead* this run once `session_expired` is seen once — every
  subsequent scrape will fail the same way, and burning the remaining URL budget on a dead
  session is pure waste. Report it distinctly in `RUN_RESULT`.
- `extraction_uncertain: true` (and `session_expired: false`) → this specific URL yielded nothing
  usable. Try the lead's next candidate URL if one remains in budget; otherwise this lead's
  outcome is `"no-new-data"`.
- Otherwise, extract fields from `main_text` (source page), `profile_page.main_text`, and
  `company_page.main_text` only — no web search, no inference from what a similar lead usually
  has, no pattern-guessing an email from a name.

**Identity resolution** — check this before extracting any identity field:
- If `original_post` is present (a resolved reshare), its `poster` is the lead's identity.
  `reposted_by`, if also present, is recorded only as a note (`lead_source_description` — not a
  top-level field), never as the contact.
- If only `reposted_by` is present (no `original_post` — the original was deleted, private, or
  unreadable), fall back to `reposted_by` as the identity but set
  `identity_confidence: "resharer-fallback"`.
- For `type: "job"`, `poster` carries a `confidence` field from the tool's job-poster heuristic:
  `"hiring-team-phrase"` (a `/in/` link whose nearby text explicitly ties it to hiring — trust it)
  or `"first-profile-link"` (a positional guess — the first `/in/` link on the page, which may be
  an unrelated "People you may know" link). For the latter, cross-check `profile_page.main_text`
  against the job's company/role before using it for identity fields; if it looks unrelated,
  treat this lead as having no confirmed poster rather than writing a likely-wrong name.
- If neither `original_post` nor `reposted_by` is present (a plain non-reshare post), use
  `poster` directly with `identity_confidence` omitted (default confidence).

**Field extraction — read every text block in full, not just the opening sentence; every value
still comes only from the scraped text/links actually in hand:**
- `company_page.main_text` (the company's **About** tab — `tools/linkedin-enrich-scrape.js`
  always forces this specific tab, confirmed against a live page to render exactly these labels
  as plain text) is the single richest source. Read it label by label, not just skimmed:
  - `Website` label → `website`.
  - `Phone` label → a company-level phone number. This is **not** the poster's personal number,
    but it is a real, callable number for outreach — see the contact-info fallback rule below for
    when to use it.
  - `Industry` label → fold into `tags` (no dedicated `industry` column here).
  - `Company size` label → the stated range (e.g. "51-200 employees", "1,001-5,000 employees") →
    `employees`. Never estimate this from industry or company name.
  - `Headquarters` label → the city portion → `city`.
  - The page's own name (its H1/title, not a link's visible text) → `organization_name` —
    prefer this over a link's visible text whenever the company hop ran.
  - An "Overview" paragraph is also present but is marketing copy, not a fact source — don't
    mine it for anything beyond what the labels above already give you.
  If the company hop did **not** run (no `company_page`), fall back to whatever company panel
  text and `organization_linkedin` link are present on the source job/post page itself
  (`main_text`) — the same fields, just a thinner source.
- `website` / `organization_linkedin` — beyond the `company_page` labels above, also accept a
  non-LinkedIn company URL (`website`) or a `linkedin.com/company/...` link
  (`organization_linkedin`) literally present in `links` or `main_text`.
- `firstname` / `lastname` / `title` — from the resolved identity's name/headline
  (`profile_page.main_text` when the profile hop ran — check both the top-of-profile headline and
  the current position line under "Experience" — else the name string LinkedIn attached to the
  post/job listing itself).
- **Contact info, in this priority order:**
  1. The resolved poster's own email/phone — scan `main_text`, `profile_page.main_text`, and
     `profile_page.contact_info_text` (the Contact info overlay, when the profile hop ran — this
     is precisely where LinkedIn puts an email/phone/website the profile owner chose to share)
     for a literal email address or phone-number-shaped string. Recruiters also occasionally put
     these directly in a job description or post body ("email your resume to...", "call/WhatsApp
     me at..."). This is the preferred source for `primary_email`/`secondary_email`/`phone`/
     `mobile`/`whatsapp` — it identifies the actual person.
  2. **Fallback — per the explicit instruction that a missing poster email/phone should not mean
     losing all contact info**: if step 1 found nothing and `company_page.main_text` has a
     `Phone` label, use that company number for `phone` (never `mobile`/`whatsapp`, which imply a
     personal device) and note the source: set
     `lead_source_description.phone_source = "company_about_page"` so it's never confused with a
     personal number if the record is later audited.
  - Expect `primary_email`/`mobile`/`whatsapp` to still read `"not available"` on most leads even
    with the company-phone fallback applied — LinkedIn does not surface personal contact info by
    default, and that is a correct outcome to report, not a gap to keep digging for.
- `linkedin` is never written, under any circumstance — it is a scrape source (see "Per-lead
  procedure" above), not a derived fact. `tools/crm-leads-update.js` also strips it from any
  request body as a hard backstop, but `lead-url-enrich`/`crm-leads-patch` must never attempt to
  include it in the first place.
- `description` — a short appended note (1–2 sentences) summarizing what enrichment found or
  didn't, not a replacement for whatever was written at insert time.
- Anything not literally present: leave the existing field untouched (never regress a populated
  value) or, for a field that was already `"not available"`/`null` and stays that way, omit it
  from the diff entirely — `crm-leads-patch` only sends fields that actually changed.

Return a diff, not a full record:
```json
{
  "lead_id": "<crm_leads row id>",
  "enriched_fields": { "...": "..." },
  "notes": { "identity_confidence": "original-post|resharer-fallback|null" },
  "urls_tried": ["<url>", "..."],
  "outcome": "enriched|partial|no-new-data|session_expired|selectors_suspect"
}
```

## 4. Batching / concurrency

`enrich-orchestrator` fans leads out to `lead-url-enrich` in batches of at most 5 concurrent
invocations (`LINKEDIN-ENRICH-CONFIG.md`) — never one agent per lead all at once. This mirrors
the sibling project's `linkedin-verify` batching discipline for the same reason: multiple agents
driving Playwright against the same persistent Chrome profile at once can invalidate each other's
page state mid-read. Invoke one batch, wait for every result in it, then invoke the next.

## 5. PATCH (`crm-leads-patch`, per lead with a non-empty diff)

Skip this step entirely for a lead whose `outcome` is `"no-new-data"` with an empty
`enriched_fields` — there is nothing to send, and sending an empty PATCH is not a meaningful
delivery.

Otherwise: read the lead's current row (already in hand from the fetch step — no re-fetch needed),
merge `enriched_fields` onto it per `schemas/crm_leads_enrich_mapping.sql`'s rules (only
newly-evidenced or explicitly-corrected fields, `lead_source_description` merged not replaced,
`source_urls` appended+deduped, `enriched_at`/`enrichment_outcome`/`identity_confidence` recorded
inside it), then:

```bash
node tools/crm-leads-update.js --id <lead-id> --log ./logs/crm-leads-enrich-responses.md --timezone "<resolved>"
```
(merged patch body via stdin)

Parse `{ commit_state, id, status, response, error }`. `commit_state: "confirmed"` is success;
`"failed"`/`"unknown"` are both reportable failures for that lead — never retried automatically
within the same run.

**Record the ledger immediately after this, for this one lead — before moving to the next lead in
the batch**, per the Idempotency section above:
```bash
node tools/processed-leads-ledger.js --record --id <lead-id> --outcome <outcome> --commit-state <commit_state> --date <resolved-date>
```
Also record a `"no-new-data"` lead this same way (immediately, before `crm-leads-patch` would
have run — there is no PATCH result for it, so pass `--outcome no-new-data` with no
`--commit-state`). Never record a `session_expired`/`selectors_suspect` lead — leave it out of
the ledger entirely so it stays `pending` for the next run.

## 6. Notification

Invoke `email-notify` at most once per run, only when one of these is true:
- The fetch step failed (`tools/crm-leads-fetch.js` returned a non-null `error`).
- `session_expired` was raised for any lead this run (terminal automation condition — a human
  needs to re-authenticate the Chrome profile).
- The run is a genuine final zero: the fetch returned `count: 0`, or every `pending` lead's
  outcome was `"no-new-data"` with nothing PATCHed.
- One or more PATCH attempts returned `"failed"`/`"unknown"` (partial or total delivery failure).

Do not notify a run that PATCHed at least one lead successfully with no failures. A run whose
entire fetched set was `already_processed` (nothing left `pending` after the ledger check) is
also not a notification trigger — it's a correctly-skipped no-op, not a zero-result run.

## 7. `RUN_RESULT`

Last line of the orchestrator's response, always, no exceptions:
```
RUN_RESULT: {"flow":"enrich","status":"success|partial|failed","fetched":0,"already_processed":0,"enriched":0,"updated":0,"failed":0,"skipped":0,"notified":true|false,"errors":["<short reason>", ...]}
```
`status` is `"success"` only if every `pending` lead with a non-empty diff PATCHed with zero
failures — a `"no-new-data"` lead is not a failure, it's correctly `skipped`, and a run where
everything was `already_processed` also counts as `"success"`; `"partial"` if some PATCHed and
some failed; `"failed"` if the fetch itself failed, `session_expired` halted the run early, or
zero leads PATCHed while failures occurred. All count fields are always-present integers, `0`
when genuinely zero. `errors` is `[]` when empty, never an omitted key.

## Maintenance

See `LINKEDIN-ENRICH-AGENT.md`'s "Selector confidence note" — `tools/linkedin-enrich-scrape.js`'s
poster/company/reshare extraction needs a real capture pass against a live job page and a live
reshare post the first time this flow runs against production data. If a run's
`extraction_uncertain` rate looks high, that file is the only place to fix it — never work around
a stale selector with agent-side pattern guessing.
