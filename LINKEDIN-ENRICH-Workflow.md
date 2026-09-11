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
company_link, links, profile_page, job_page, company_page, hops_done, extraction_uncertain,
session_expired, selectors_suspect, error, started_at, finished_at, duration_ms }`.

`job_page` (`{ url, main_text, company_link }` or `null`) is populated only for a **post** source
that had no direct `/company/` link and instead embedded a "View job" card — the tool opens that
job page once to resolve the employer, then runs the normal company About hop from it. When
present, `hops_done` includes `"job"` and `company_page` is populated the same as for a job source
URL. Treat `job_page.main_text` as an additional company-fact source (it carries an "About the
company" blurb), ranked below `company_page.main_text` but above nothing.

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
- Otherwise, extract fields from `main_text` (source page), `profile_page.main_text`,
  `company_page.main_text`, and `job_page.main_text` (when the post's job hop ran) only — no web
  search, no inference from what a similar lead usually has, no pattern-guessing an email from a
  name.

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
  - `Industry` label → **always** fold the raw text into `tags` (no loss either way). **Also** set
    `industry` to the matching **id** in `schemas/CRM_Leads_Field_Reference.json`'s `industry`
    enum (16 labels: Service Provider, ManagementISV, MSP, ERP, Large Enterprise, Systems
    Integrator, ...), but only on a confident, near-exact match — never the label text itself, and
    never a guessed closest option. LinkedIn's own industry taxonomy rarely maps cleanly onto this
    legacy list, so most leads legitimately get no `industry` id even though `tags` still gained
    the raw text. **This id must come from actually reading the reference file this run** (e.g.
    `cat`/`grep` it) — never from memory of a previous lead's ids; an unread/misremembered id is
    the most likely reason this field ends up silently omitted when a real match existed.
  - `Company size` label → `employees`, as a **whole number** (the column is Integer). Take the
    lower bound of the stated range as an integer — "51-200 employees" → `51`, "1,001-5,000
    employees" → `1001` (strip commas) — or a single stated headcount as-is. Never send the range
    string itself (the tool will drop it), and never estimate from industry or company name.
  - `Headquarters` label → the city portion → `city` (always, as before). Also try to match the
    country/region portion against the `country` and `state` enums in
    `schemas/CRM_Leads_Field_Reference.json` — read the file itself for the literal ids, same as
    `industry` above — and send the matching **id** (never the label) on a confident match:
    `country`'s labels are each unique, so a clearly-named country is safe.
    `state`'s list has genuine **duplicate labels mapped to different ids** ("Illinois", "Georgia",
    "Telangana", and "Maharashtra" each appear twice, as of this file) — a CRM data-quality issue
    this flow cannot resolve from LinkedIn text alone. When the matched state label is one of
    those, or the match is otherwise ambiguous, **omit `state` entirely** rather than guess between
    the ids; `city`/`country` are unaffected and should still be sent.
  - The page's own name (its H1/title, not a link's visible text) → `organization_name` —
    prefer this over a link's visible text whenever the company hop ran.
  - An "Overview" paragraph is also present but is marketing copy, not a fact source — don't
    mine it for anything beyond what the labels above already give you.
  If the company hop did **not** run (no `company_page`), fall back to `job_page.main_text` when a
  post's job hop ran (its "About the company" blurb), then to whatever company panel text and
  `organization_linkedin` link are present on the source job/post page itself (`main_text`) — the
  same fields, each successively thinner sources.
- `tags` — beyond the `Industry` label folded in above, pull in any skills, technologies, tools, or
  role/seniority keywords **literally named** in `main_text`/`job_page.main_text`/
  `company_page.main_text` (the same kind of content `lead_source_description.skills_in_jd` already
  captures at insert time — this is a separate column landing the same signal). Merged as a
  deduplicated union with the row's existing `tags`, never replaced, never an invented skill.
- `website` — beyond the `company_page` label above, also accept a non-LinkedIn company URL
  literally present in `links` or `main_text`.
- `organization_linkedin` — primarily the scrape tool's own top-level **`company_link`** field
  (not a re-scan of `links`/`main_text`). This matters most for a **post**: when the employer was
  only resolvable through an embedded "View job" card (see the `job_page` note above),
  `company_link` carries the resolved URL from `job_page.company_link` — a URL that was found on a
  *different page* than the post itself and will never appear in the post's own `links`/`main_text`.
  Only fall back to scanning `links`/`main_text` for a literal `linkedin.com/company/...` URL when
  `company_link` is null.
- `facebook` / `instagram` / `google_chat` / `teams_id` are the resolved **person's** own handles,
  never the company's — source only from `profile_page.main_text`, `profile_page.contact_info_text`,
  or the poster's own words in `main_text` (e.g. "follow me on Instagram @handle", a stated Teams
  or Google Chat address). A company's own social links on `company_page` are not these fields.
  LinkedIn essentially never surfaces a Teams id or Google Chat handle, so those two legitimately
  stay `"not available"` on nearly every lead — include a field only when the page states one
  directly for this person, never inferred.
- `firstname` / `lastname` / `title` — from the resolved identity's name/headline
  (`profile_page.main_text` when the profile hop ran — check both the top-of-profile headline and
  the current position line under "Experience" — else the name string LinkedIn attached to the
  post/job listing itself). `firstname`/`lastname` columns only accept `^[a-zA-Z ]*$` (ASCII
  letters and spaces). If the real name has a hyphen, apostrophe, accent, or period, do **not**
  reshape it into something false — omit `firstname`/`lastname` and record the actual name in the
  `description` note instead. `title` has no such restriction.
- `linkedin` — the resolved identity's own profile URL (`profileUrl` on `poster`, or on
  `original_post.poster` for a resolved reshare), written back **only** under the same
  identity-confidence gate as `firstname`/`lastname`/`title` above: don't write it for an
  unconfirmed `first-profile-link` job-poster guess, and prefer the original poster over a
  resharer. This is a deliberate exception to "never regress" leniency in the other direction —
  the column may already hold whatever URL the row was inserted with (a post link, not
  necessarily a profile); a confidently-resolved profile URL is a genuine improvement and should
  overwrite it.
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
- `job_posting_url` is never written, under any circumstance — it is the row's own identity (which
  URL it was inserted from). `tools/crm-leads-update.js` also strips it from any request body as a
  hard backstop, but `lead-url-enrich`/`crm-leads-patch` must never attempt to include it in the
  first place.
- `lead_source` is always DERIVED by `tools/crm-leads-update.js` from the lead's own
  `job_posting_url` (passed as `--job-posting-url`, never part of the JSON body), matched against
  `schemas/CRM_Leads_Field_Reference.json`'s `lead_source` enum by domain — never a bare hardcoded
  constant, and never something `lead-url-enrich`/`crm-leads-patch` compute or include in the body.
  Every `job_posting_url` this flow ever sees is a LinkedIn URL, so this resolves to the "LinkedIn"
  id in practice — but the tool actually checks the URL each time, and a lead whose
  `job_posting_url` is empty/`"not available"` or doesn't match a known platform simply gets no
  `lead_source` in its patch, never a guess.
- `linkedin` is written (see the `firstname`/`lastname`/`title` bullet above) — it is also still a
  scrape source read from at the start of "Per-lead procedure" above (the lead's *existing* value
  is one candidate URL to open), so the same field is both read as input and, once a confident
  identity is resolved, written as output for a given run.
- `description` — **always populate this key, one way or the other; it is never skipped just
  because the rest of the row was already well-known.** If the lead's existing `description` is
  empty/`"not available"`, extract the actual job/post description text: for a `post`, `main_text`
  is already just the caption and can be used directly; for a `job`, `main_text` is the *entire
  page* (header, description body, then "Similar jobs"/footer boilerplate) — extract only the
  description section, not the raw blob. If `description` already has real content (common on
  `job` leads captured at insert time), `crm-leads-patch` instead appends a short 1–2 sentence note
  summarizing what enrichment confirmed — that note is itself new evidence about this run and must
  not be skipped under the general "omit unchanged facts" rule, which applies to repeated facts,
  not to this note.
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
node tools/crm-leads-update.js --id <lead-id> --log ./logs/crm-leads-enrich-responses.md --timezone "<resolved>" --job-posting-url "<lead's job_posting_url>"
```
(merged patch body via stdin)

**Every value must fit its CRM column.** `tools/crm-leads-update.js` validates each allow-listed
field against `schemas/CRM_Leads_Field_Reference.json` (the column's `field_type`, its validation
regex, and any enumerated option list) before sending — anything that doesn't fit is dropped and
returned in `invalid_keys` (`[{ key, reason }]`), never sent. So `crm-leads-patch` must already
produce column-fitting values: `employees` a whole number (the lower bound of a "51-200" range,
or a single stated headcount — never the range string); `firstname`/`lastname` only ASCII letters
and spaces (`^[a-zA-Z ]*$` — if the real name has hyphens/apostrophes/accents, omit the field and
put the name in `description`); `secondary_email` a valid email; `tags` a JSON array of strings;
`lead_source_description` a JSON object. A non-empty `invalid_keys` on a `confirmed` result means
those fields silently did not land — surface it, don't ignore it.

Parse `{ commit_state, id, status, response, error, dropped_keys, invalid_keys }`. **Exactly one
PATCH request is sent per lead — never a second call, no retry, no backoff, for any failure mode
(non-2xx, transport error, timeout, ambiguous send).** `commit_state: "confirmed"` is success. `"failed"` (a non-2xx
response) and `"unknown"` (the send itself errored) are each that lead's **final** outcome for
this run: the lead is counted as failed, `RUN_RESULT` reflects it, and the failure email is sent
per the Notification section below — nothing re-attempts the call. The lead is deliberately left
out of the idempotency ledger, so a *separate future* `/enrich` run for the same date may try it
again; that is not an in-run retry and is the only "retry" that exists.

Every real send (never a `--dry-run`) also appends its exact request body to the JSON array in
`./logs/crm-leads-enrich-payloads.json` — one element per send: `payload` (the body as sent),
`id`, `target`, `fields`, `dropped_keys`, `commit_state`, `http_status`, `duration_ms`, and both a
UTC `logged_at` and the resolved-local `date`/`time`/`timezone`. The file is read-modified-written
atomically (temp file + rename). This is a payload audit trail separate from the human-readable
response log; `tools/crm-leads-update.js` writes it on its own — `crm-leads-patch` neither manages
nor passes anything for it.

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
