---
description: Sends one SMTP notification for a qualifying /enrich outcome (fetch failure, session_expired, final zero, or a PATCH failure)
mode: subagent
model: opencode/big-pickle
steps: 15
permission:
  task: deny
  edit: deny
  bash: allow
  skill: deny
---

- Run only when the orchestrator supplies one qualifying trigger from `LINKEDIN-ENRICH-Workflow.md`'s
  Notification section: fetch failure, `session_expired`, a genuine final zero (zero leads
  fetched, or every fetched lead ended `no-new-data`), or any PATCH attempt that came back
  `failed`/`unknown`. Never notify a run that PATCHed at least one lead with zero failures.
- Read SMTP settings as environment variables (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
  `SMTP_PASS`, `SMTP_FROM`) — OS/shell-level convention, `.env` an optional supplement never a
  requirement. Recipients are the deduplicated union of `NOTIFY_BDE_EMAILS` and
  `NOTIFY_DEV_EMAILS` (comma-separated).
- **Send by calling `scripts/Send-EnrichNotification.ps1` — never compose the email or the SMTP
  call yourself.** It resolves SMTP settings and recipients (Process/User/Machine scope, then
  `.env`), builds the body, validates addresses, and sends as UTF-8.
  **Invoke it as ONE single-line command through the `powershell` executable explicitly — never
  a multi-line command with backtick (`` ` ``) line-continuations.** This project's `bash` tool
  may run through a POSIX-style shell rather than PowerShell itself; a trailing backtick means
  "start a command substitution" there instead of "continue this line," and the call will hang
  waiting for a closing backtick that never comes — indistinguishable from a stuck run with no
  further output. A single line avoids the ambiguity regardless of which shell is actually
  underneath:
  ```
  powershell -NoProfile -ExecutionPolicy Bypass -File "scripts/Send-EnrichNotification.ps1" -Result "<FAILURE | NO DATA | OTHERS>" -Headline "<one plain-English sentence>" -KeyFacts "<label>: <value>","<label>: <value>" -Trigger "<what specifically caused this email>" -RunResultJson "<the RUN_RESULT JSON, or: not available to this stage>" -LogPath "<log path, or: see logs/ on the run machine>"
  ```
  It prints one JSON line: `{"result":"sent","recipients":N,"masked":"..."}`, or
  `{"result":"configuration-incomplete",...}` / `{"result":"failed",...}`. Report that verbatim.
- **`Result` and the headline, by trigger:**
  - **Fetch failure** or **`session_expired`** (terminal, no deliverable path forward) →
    `RESULT: FAILURE`. Headline: `"Automation error during enrich - the run could not complete. Developer attention needed."`
    `KeyFacts`: resolved date, what failed (fetch / a lead's scrape / PATCH), counts already
    confirmed before the failure.
  - **Genuine final zero** → `RESULT: NO DATA`. Headline:
    `"No AI-generated leads needed enrichment in this run - a normal outcome, not an error."`
    `KeyFacts`: resolved date, leads fetched, leads with no new data and why (aggregated).
  - **Partial PATCH delivery** (some confirmed, some failed/unknown) → `RESULT: OTHERS`.
    Headline: `"Enrich run completed with mixed results - see details below."` `KeyFacts`:
    confirmed/failed/unknown counts.
- Send exactly one email per run. Do not attach payloads, credentials, or private source content.
  Do not retry more than once after a clearly failed SMTP connection; never retry an ambiguous
  send.
- Return `sent`, `failed`, `unknown`, or `configuration-incomplete`, recipient addresses masked,
  and a short safe status. Notification failure must be reported but must not change an already
  successful PATCH outcome into a delivery failure.
