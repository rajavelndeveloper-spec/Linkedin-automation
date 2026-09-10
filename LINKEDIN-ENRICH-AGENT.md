# LinkedIn lead enrichment contract

## Goal

Every existing `crm_leads` row that is AI-generated and was created recently already carries a
`job_posting_url` and/or `lead_source_description.source_urls` — real LinkedIn URLs captured at
insert time. This flow opens those exact URLs (never searches), scrapes whatever company and
poster identity is literally on the page (and one bounded profile/company hop beyond it), and
PATCHes the same row with whatever it found. Fields with no evidence stay the existing
`"not available"`/`null` sentinel — this is an evidence-completeness discipline, not a claim
that every lead ends up fully enriched.

## Architecture

`command → enrich-orchestrator → tools/crm-leads-fetch.js (fetch) → lead-url-enrich (scrape +
reason, per lead) → crm-leads-patch (merge + PATCH, per lead) → email-notify (on failure/zero)`

- Workers are opencode subagents and cannot delegate further.
- `LINKEDIN-ENRICH-CONFIG.md` owns changeable defaults; explicit run arguments override only
  named settings. This file and `LINKEDIN-ENRICH-Workflow.md` own behavior, evidence, PATCH, and
  logging contracts.
- The direction of data flow is the opposite of a sibling project
  (`ai-automation-system`'s `/jobs`/`/posts`, referenced here only as a structural pattern, never
  modified by this project): those discover and INSERT new leads via a custom extension
  endpoint; this flow FETCHes and PATCHes existing leads via Directus's native REST endpoint
  with a plain Bearer token. Different auth scheme, same possible host — see `.env.example` for
  why the env vars are named separately (`CRM_ENRICH_API_URL`/`CRM_ENRICH_API_TOKEN`, not
  `CRM_LEADS_API_URL`/`CRM_LEADS_API_SECRET`).
- This flow never inserts a new `crm_leads` row and never touches a row's identity fields
  (`job_posting_url`, `is_ai_generated`, `lead_source`, `lead_status`, `primary_bde`,
  `recommended_for_outreach`) — see `schemas/crm_leads_enrich_mapping.sql`'s allow-list. `linkedin`
  belongs in this same never-written category, with one added wrinkle: it is also an *active
  scrape input* (`lead-url-enrich.md` treats it as a third URL candidate alongside
  `job_posting_url` and `source_urls`, since it can hold a post link rather than a resolved
  profile) — read from constantly, never written to, enforced in `tools/crm-leads-update.js`'s
  code, not just agent instructions.
- Discovery of *which* leads to process is deterministic (`tools/crm-leads-fetch.js`, one GET per
  run); discovery of *what's on each URL* is deterministic Playwright
  (`tools/linkedin-enrich-scrape.js`), not an LLM navigating a browser tool-call by tool-call —
  same philosophy as the sibling project's `/jobs`/`/posts`, and for the same reason (an LLM
  driving navigation step by step measured roughly an order of magnitude slower per page there).
  Judgment — which field means what, whether a reshare's original poster is the real contact,
  what merits `"not available"` — belongs to `lead-url-enrich.md`, never to the scrape tool.
- Only `crm-leads-patch` sends CRM write requests, and only `email-notify` sends SMTP mail. A
  fully empty run (zero leads fetched, or every fetched lead ending `no-new-data`) still reports
  through `RUN_RESULT` but does not necessarily notify — see "Notification" below.

## Evidence and efficiency

- The scrape tool returns raw page text and links, never conclusions. `lead-url-enrich.md` reads
  only what that tool returned for the URL(s) it actually opened this run — no web search, no
  external lookup, no filling a gap from what "similar leads" usually have.
- Never invent a name, email, phone, headcount, or URL. Undetermined string fields stay
  `"not available"`; undetermined numeric fields (`employees`) stay untouched if already set,
  else `null`. Most leads will legitimately keep `"not available"` for phone/email after
  enrichment — LinkedIn does not expose contact info by default, and a scraped page having none
  is a correct, reportable outcome, not a failed run.
- **Reshare resolution is mandatory, not optional**: when `tools/linkedin-enrich-scrape.js`
  returns both `reposted_by` and `original_post`, the original post's poster is the lead —
  never the resharer. A resharer-only fallback (original unreadable) must be flagged
  `identity_confidence: "resharer-fallback"` in the PATCH body, never presented as equal
  confidence to a genuine original-poster match.
- At most 3 URLs are tried per lead (`job_posting_url` first, then the lead's own `linkedin`
  column if different, then the first unseen `lead_source_description.source_urls` entry) and at
  most 4 page loads per URL attempt (source + profile main + profile Contact info overlay +
  company About tab) — both hard-capped in code
  (`LINKEDIN-ENRICH-CONFIG.md`/`tools/linkedin-enrich-scrape.js`), not agent reasoning. This
  bounds both LLM cost and LinkedIn account-risk footprint per lead.
- Parallelize only independent leads with isolated browser state (see Batching below). Never
  create an agent per URL within a single lead — one `lead-url-enrich` invocation owns the whole
  URL-selection-and-hop sequence for its lead.

## Delivery invariants

- `crm-leads-patch` builds a **merge-only** patch: a key is sent only when it moves a field from
  empty/`"not available"`/`null` to a real evidenced value, or is an explicitly-evidenced
  correction (e.g., a confirmed different employee count read directly off the company page).
  It never regresses a populated real value back to a sentinel, and it never sends a bare
  replacement for `lead_source_description` — it reads the row's existing value first and merges
  into it (see `schemas/crm_leads_enrich_mapping.sql`).
- Before every `tools/crm-leads-update.js` run, `crm-leads-patch` compares that existing runner
  against this file and `LINKEDIN-ENRICH-Workflow.md`'s live PATCH contract. It updates that same
  script in place only for a material mismatch, verifies it, then sends. No duplicate runner,
  alternate script, or helper file — same discipline as the sibling project's
  `linkedin-api-publish.md`.
- **One PATCH request per lead, no retry.** `tools/crm-leads-update.js` sends exactly one HTTP
  PATCH per invocation and never re-sends — no second attempt, no backoff — for any failure mode
  (non-2xx, transport error, timeout, ambiguous send). A `failed`/`unknown` result is that lead's
  final outcome for the run: it is reported as a failure through `RUN_RESULT` and always triggers
  the notify step. There is no local-file fallback; nothing in this project is ever written to
  disk as a delivery target except the gitignored operational logs under `logs/`. The lead is not
  written to the idempotency ledger on failure, so a *separate future* `/enrich` run may retry it
  — that cross-run re-attempt is the only retry that exists.
- `tools/crm-leads-update.js` writes two PATCH logs automatically, both only under the gitignored
  `logs/` dir and never a delivery target: a human-readable markdown response log grouped by
  attempt with resolved-local Date/Time and safe row details (no payload, no secrets, no
  headers), and a JSON-array payload audit log (`logs/crm-leads-enrich-payloads.json`, rewritten
  atomically on each append) holding the exact request body of every real send — including any
  contact values it carried — with UTC and resolved-local timestamps. Agents never write either
  file directly and never add a third log; do not log secrets, headers, or credentials anywhere
  beyond what that tool already writes.

## Change and audit rule

When architecture changes, synchronize `LINKEDIN-ENRICH-CONFIG.md`, `LINKEDIN-ENRICH-Workflow.md`,
`.opencode/commands/enrich.md`, the three enrich agents, `schemas/crm_leads_enrich_mapping.sql`,
and `README.md`. Keep the command as a launcher, agents as role boundaries, and this file plus
`LINKEDIN-ENRICH-Workflow.md` as the maintenance contract. Verify names, permissions, env var
names, and PATCH routing for contradictions. Do not add brittle selectors, fixed click recipes,
fabricated facts, credentials, ad-hoc generated helper files, or a duplicate maintained tool.
Runtime contract maintenance may edit the existing configured runners only
(`tools/linkedin-enrich-scrape.js`, `tools/crm-leads-fetch.js`, `tools/crm-leads-update.js`).

**Selector confidence note**: `tools/linkedin-enrich-scrape.js`'s poster/company/reshare
extraction was written without a live authenticated LinkedIn session to verify selectors against
(unlike the sibling project's Jobs/Posts selectors, which were captured empirically). It leans on
class-hash-resistant signals (raw `innerText`, href-pattern link matching, the proven
`aria-label` technique) and reports `extraction_uncertain: true` rather than a false-confident
empty result — but it still needs a real capture pass against a live job page and a live reshare
post the first time this flow actually runs, the same discipline the sibling project's own
selectors were held to. Tighten it there, in that one file, if a real run's
`extraction_uncertain` rate looks high.
