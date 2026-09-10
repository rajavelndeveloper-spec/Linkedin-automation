---
description: Fetch AI-generated crm_leads rows and enrich each from its own known LinkedIn URL(s)
agent: enrich-orchestrator
---

Execute the enrich flow now. The following block contains the authoritative arguments supplied
to this invocation:

<invocation_arguments>
$ARGUMENTS
</invocation_arguments>

Parse and preserve that block before reading defaults. Expected syntax: `[date=YYYY-MM-DD] [limit=N]`,
space-separated, both optional, e.g. `limit=10` or `date=2026-09-08 limit=25`. **Never a leading
`--`** — `opencode run`'s own CLI parser intercepts any message token starting with `--` before
it reaches this command at all, so the invocation syntax deliberately avoids that shape (same
reason the invocation examples elsewhere in this project never use `--flag` style). `date`
defaults to today's UTC calendar day, resolved fresh for this run — never assume or carry over a
previous run's date. Use `@LINKEDIN-ENRICH-CONFIG.md`'s defaults for anything not named. Use
`@LINKEDIN-ENRICH-Workflow.md` for run rules. Resolve any other explicit override semantically
and report only genuine ambiguity.

Do not explain the command, search project files for context, or ask for setup. Fetch once,
dispatch the required workers per lead, and finish through the PATCH step and `RUN_RESULT` line.
