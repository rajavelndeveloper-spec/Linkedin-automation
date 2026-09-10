#!/usr/bin/env node
/**
 * Local idempotency ledger for /enrich - tracks which crm_leads rows have
 * already been fully processed (successfully enriched+patched, or
 * conclusively found to have no new data) so an accidental re-run of the
 * same day's fetch doesn't re-scrape LinkedIn or re-spend opencode/LLM cost
 * on leads that are already done. This is local run state, not a CRM
 * field - nothing here is ever sent to Directus.
 *
 * Ledger file: state/processed-leads.json (gitignored), a plain JSON object
 * keyed by lead id. Written atomically (temp file + rename, so a process
 * killed mid-write never corrupts the file) and updated once per lead as
 * each one finishes - never batched to the end of the run - so a crashed or
 * interrupted run still preserves every lead it did complete.
 *
 * Usage:
 *   node processed-leads-ledger.js --check           (JSON array of lead ids on stdin)
 *     -> { pending: [...], skipped: [...] } on stdout
 *   node processed-leads-ledger.js --record --id <id> --outcome <outcome> [--commit-state <state>] [--date <date>]
 *     -> { id, entry } on stdout
 *
 * A lead counts as done (skipped on --check) only for a genuinely terminal
 * result: outcome "enriched"/"partial" with commit-state "confirmed", or
 * outcome "no-new-data" (nothing to patch, and re-scraping the same page
 * again would find the same nothing). A failed PATCH, an unknown commit
 * state, or a session_expired/selectors_suspect outcome is NOT terminal -
 * that lead is left pending so the next run retries it once the underlying
 * problem (a lapsed session, a transient API failure) is fixed.
 */

const fs = require("fs");
const path = require("path");

const LEDGER_PATH = path.resolve(__dirname, "..", "state", "processed-leads.json");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--check") args.check = true;
    else if (argv[i] === "--record") args.record = true;
    else if (argv[i] === "--id") args.id = argv[++i];
    else if (argv[i] === "--outcome") args.outcome = argv[++i];
    else if (argv[i] === "--commit-state") args.commitState = argv[++i];
    else if (argv[i] === "--date") args.date = argv[++i];
  }
  return args;
}

function readLedger() {
  try {
    if (!fs.existsSync(LEDGER_PATH)) return {};
    const raw = fs.readFileSync(LEDGER_PATH, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    // A corrupted ledger should never block a run - treat it as empty
    // rather than crash. Worst case: one run re-processes leads it already
    // did (safe, just wasteful) - never the reverse (silently skipping
    // something that was never actually done).
    return {};
  }
}

function writeLedgerAtomic(ledger) {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  const tmpPath = `${LEDGER_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(ledger, null, 2));
  fs.renameSync(tmpPath, LEDGER_PATH);
}

function isTerminal(entry) {
  if (!entry) return false;
  if (entry.outcome === "no-new-data") return true;
  if ((entry.outcome === "enriched" || entry.outcome === "partial") && entry.commit_state === "confirmed") {
    return true;
  }
  return false;
}

function readStdinJson() {
  const raw = fs.readFileSync(0, "utf8");
  if (!raw.trim()) return [];
  const ids = JSON.parse(raw);
  if (!Array.isArray(ids)) throw new Error("Expected a JSON array of lead ids on stdin.");
  return ids;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.check) {
    let ids;
    try {
      ids = readStdinJson();
    } catch (error) {
      console.log(JSON.stringify({ pending: [], skipped: [], error: String(error) }));
      process.exitCode = 1;
      return;
    }
    const ledger = readLedger();
    const pending = [];
    const skipped = [];
    for (const id of ids) {
      if (isTerminal(ledger[id])) skipped.push(id);
      else pending.push(id);
    }
    console.log(JSON.stringify({ pending, skipped, error: null }));
    return;
  }

  if (args.record) {
    if (!args.id || !args.outcome) {
      console.log(
        JSON.stringify({
          error: "Usage: --record --id <id> --outcome <outcome> [--commit-state <state>] [--date <date>]",
        })
      );
      process.exitCode = 1;
      return;
    }
    const ledger = readLedger();
    const entry = {
      processed_at: new Date().toISOString(),
      date: args.date || new Date().toISOString().slice(0, 10),
      outcome: args.outcome,
      commit_state: args.commitState || null,
    };
    ledger[args.id] = entry;
    writeLedgerAtomic(ledger);
    console.log(JSON.stringify({ id: args.id, entry, error: null }));
    return;
  }

  console.log(
    JSON.stringify({
      error:
        "Usage: --check (stdin: JSON array of lead ids) | --record --id <id> --outcome <outcome> [--commit-state <state>] [--date <date>]",
    })
  );
  process.exitCode = 1;
}

main();
