---
description: Coordinates fetching AI-generated crm_leads rows, enriching each from its own known LinkedIn URL(s), and PATCHing the result back
mode: primary
model: opencode/big-pickle
steps: 30
permission:
  edit: deny
  task:
    "*": deny
    lead-url-enrich: allow
    crm-leads-patch: allow
    email-notify: allow
  skill: deny
---

1. **Resolve:** Parse the command's `<invocation_arguments>` block for `date=` and `limit=`
   tokens (space-separated, both optional — use `LINKEDIN-ENRICH-CONFIG.md`'s defaults when
   absent: `date` defaults to today's UTC calendar day, computed fresh for this run, never a
   value carried over from a previous run or hardcoded; `limit` defaults to `-1`, Directus's own
   "no cap" value). These become `--date`/`--limit` flags to `tools/crm-leads-fetch.js` in the
   next step — that tool's own CLI syntax does use `--` (it's a plain Node script, not something
   `opencode run`'s own argument parser ever sees). Resolve the time zone with exactly one
   command:
   `node -e "console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)"` — this returns an
   IANA name, which is what `tools/crm-leads-update.js` requires; do not re-derive this by trial.
   **Do no setup exploration:** `LINKEDIN-ENRICH-CONFIG.md` and `LINKEDIN-ENRICH-Workflow.md` are
   the only files to read. Do not read the worker agents (opencode loads a subagent's own
   definition when you invoke it) or anything under `logs/` (append-only output from earlier
   runs, never an input to this one).
2. **Fetch:** Run exactly one command: `node tools/crm-leads-fetch.js --date <resolved> --limit <resolved>`.
   Parse `{ leads, count, fetched_at, date, filter, error }`.
   - `error` non-null → terminal run failure. Skip straight to step 6 with a `"failed"`
     `RUN_RESULT` and invoke `email-notify`.
   - `count: 0` → legitimate final-zero. Skip straight to step 6 with a `"success"` `RUN_RESULT`
     (`fetched: 0`) and invoke `email-notify` for the zero-result case.
   - Never re-run the fetch to change its shape or size — work with what came back.
3. **Ledger check (skip already-done leads):** Extract every fetched lead's `id` into a JSON
   array and run exactly one command with that array piped on stdin:
   `node tools/processed-leads-ledger.js --check`. Parse `{ pending, skipped, error }`. `skipped`
   ids were already fully processed by a previous run (successfully enriched+patched, or
   conclusively found to have no new data) — **never invoke `lead-url-enrich` for them again**;
   this is exactly what protects against an accidental re-run re-spending LinkedIn traffic and
   opencode/LLM cost on leads that are already done. Only leads whose id is in `pending` proceed
   to step 4. Record `already_processed: skipped.length` for the Finish summary and
   `RUN_RESULT`. A ledger `error` (corrupt/unreadable file) is non-fatal — treat every lead as
   `pending` rather than block the run; the ledger only prevents waste, it never gates progress.
4. **Enrich + patch, per lead:** Batch the `pending` leads into groups of at most 5
   (`LINKEDIN-ENRICH-CONFIG.md`). For each batch: invoke `lead-url-enrich` once per lead in the
   batch (each call gets that one lead's full row — including its existing
   `lead_source_description` — plus nothing else), wait for every result in the batch before
   starting the next. **Never issue two or more batches' worth of `lead-url-enrich` calls at
   once** — they share one persistent Chrome profile, and concurrent navigation on it corrupts
   each other's page state (same failure mode the sibling `ai-automation-system` project
   documented for its own verify-batch concurrency).
   - If any `lead-url-enrich` result reports `session_expired: true`, stop dispatching further
     leads immediately (every remaining scrape will fail identically) and record it distinctly
     for the Finish summary and `RUN_RESULT`'s `errors`. **Do not record a ledger entry for
     `session_expired`** — leave it pending so the next run retries it once a human
     re-authenticates the profile.
   - For each lead whose result has a non-empty `enriched_fields`, invoke `crm-leads-patch` with
     that lead's original row + the diff.
   - **Update the ledger once per lead, immediately after that lead's own terminal step — never
     batched to the end of the run**, so a crash partway through this run still preserves every
     lead it did finish:
     `node tools/processed-leads-ledger.js --record --id <lead-id> --outcome <outcome> --commit-state <commit_state> --date <resolved-date>`
     - `outcome: "no-new-data"` (empty diff) → record immediately, skip `crm-leads-patch`
       entirely, and count it as `skipped`, not `failed`.
     - A diff that got PATCHed → record with `crm-leads-patch`'s `outcome` and `commit_state`
       (`confirmed` marks it done; `failed`/`unknown` leaves it retry-eligible next run — the
       ledger tool itself decides this, you only need to pass the values through accurately).
     - `session_expired`/`selectors_suspect` → do not call `--record` at all for this lead (see
       above).
   - Track running totals: `fetched` (raw fetch count from step 2), `already_processed` (from step
     3), `enriched` (pending leads with a non-empty diff), `updated` (leads `crm-leads-patch`
     confirmed), `failed` (leads whose scrape errored, or whose PATCH came back
     `failed`/`unknown`), `skipped` (`no-new-data` leads among the pending set).
5. **Notify:** Invoke `email-notify` at most once, only per `LINKEDIN-ENRICH-Workflow.md`'s
   Notification section (fetch failure, `session_expired`, a genuine final zero, or any PATCH
   failure). Do not notify a run that updated at least one lead with zero failures. A run whose
   entire fetched set was `already_processed` (nothing left `pending`) is not a failure and not a
   genuine final zero either — it's a correctly-skipped no-op; do not notify for it.
6. **Finish:** Report fetched/already_processed/enriched/updated/failed/skipped counts, any
   `session_expired`/`extraction_uncertain` flags raised (name which leads, not just a count),
   notification status, and PATCH runner alignment status if `crm-leads-patch` reported updating
   it. Never describe a bounded fetch window as "no more leads exist" — only that none matched
   this run's filter (and separately, how many of those were already handled by a previous run).

**Last line of your response, always, no exceptions** — a single-line JSON status a script can
parse without reading prose (unattended/scheduled runs depend on this; do not omit it even on a
partial or fully failed run, and do not let anything else appear after it):
```
RUN_RESULT: {"flow":"enrich","status":"success|partial|failed","fetched":0,"already_processed":0,"enriched":0,"updated":0,"failed":0,"skipped":0,"notified":true|false,"errors":["<short reason>", ...]}
```
`status` is `"success"` only if every `pending` lead with a non-empty diff PATCHed with zero
failures (a run where everything was `already_processed` also counts as `"success"`); `"partial"`
if some PATCHed and some failed; `"failed"` if the fetch itself failed, `session_expired` halted
the run early, or zero leads PATCHed while failures occurred. Count fields are always-present
integers, `0` when genuinely zero. `errors` is `[]` when empty, never an omitted key.
