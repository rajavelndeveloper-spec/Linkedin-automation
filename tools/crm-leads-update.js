#!/usr/bin/env node
/**
 * Sequential CRM row updater for /enrich - PATCHes one existing crm_leads row
 * via Directus's native REST endpoint (/items/crm_leads/{id}), Bearer auth.
 * Dependency-free (fs/https/http/crypto only), same convention as every
 * other tool in this project. This never inserts a new row - only updates a
 * row that already exists, and only with an allow-listed set of enrichable
 * fields (see ALLOWED_TOP_KEYS below) - crm-leads-patch.md is responsible for
 * the merge-only decision of *which* fields belong in the body before it
 * ever reaches this script; this script's job is validating the shape and
 * sending it, not deciding content.
 *
 * SHAPE VALIDATION is driven by schemas/CRM_Leads_Field_Reference.json - the
 * CRM's own column catalogue (type + validation regex + enumerated options).
 * After the allow-list filter, every remaining value is checked against its
 * column: wrong type (a range string in the Integer `employees` column), a
 * value the column's regex rejects (`firstname`/`lastname` are `^[a-zA-Z ]*$`,
 * `secondary_email` is an email pattern), a non-array `tags`, or a lookup
 * value outside the column's option list is DROPPED and returned in
 * `invalid_keys` - never sent, so a bad value becomes a visible skip here
 * instead of an HTTP 4xx from Directus. Clean numeric strings are coerced to
 * numbers for Integer columns. If the reference file itself can't be loaded,
 * the run fails closed (no PATCH) rather than sending unvalidated.
 *
 * EXACTLY ONE PATCH request is made per invocation - never more than one.
 * There is no retry, no second attempt, no backoff loop, for any failure
 * mode (non-2xx response, transport/network error, timeout, ambiguous send).
 * The single HTTP call's result is final: 2xx -> commit_state "confirmed";
 * anything else -> "failed" (a response was received) or "unknown" (the send
 * itself errored). A "failed"/"unknown" result IS the lead's failure - the
 * caller reports it through RUN_RESULT and sends the failure email, it does
 * not ask this script to try again. (Re-attempting a still-pending lead is a
 * concern of a whole separate future /enrich run, never of this process.)
 *
 * Usage:
 *   node crm-leads-update.js --id <lead-id> --log <path> --timezone <tz>
 *     [--payload-log <path>] [--job-posting-url <url>] [--dry-run]
 * (complete validated JSON patch-body on stdin)
 *
 * --job-posting-url is the lead's OWN job_posting_url (never sent as patch
 * content) - used only to derive `lead_source` by matching its domain against
 * schemas/CRM_Leads_Field_Reference.json's lead_source enum (see
 * classifyLeadSourceId()). Omit it (or pass an empty/"not available" value)
 * and `lead_source` is simply left out of the patch - never guessed.
 *
 * --dry-run prints the resolved target + body without sending anything -
 * this flow writes to CRM rows that already exist, unlike an insert, so it
 * is worth confirming the exact PATCH before the first real send.
 *
 * Output: one JSON object on stdout - { commit_state, id, status, response,
 * error, dropped_keys, invalid_keys }. commit_state is "confirmed",
 * "failed", "unknown", or "dry-run". dropped_keys lists non-allow-listed
 * keys removed; invalid_keys lists { key, reason } for allow-listed values
 * that failed field-reference validation.
 *
 * Side-effect logs (both under the gitignored logs/ dir, written automatically -
 * no agent manages them):
 *   1. --log  : a human-readable markdown table, one row per attempt, with
 *               resolved-local Date/Time and safe row details (no payload).
 *   2. --payload-log : a JSON-array payload audit file (pretty-printed) - one
 *               array element appended per REAL send (never on --dry-run)
 *               holding the exact request body that went to Directus, the
 *               target row, the field/dropped-key lists, the outcome, and
 *               both a UTC `logged_at` and the resolved-local
 *               `date`/`time`/`timezone`. Read-modify-write, done atomically
 *               (temp file + rename) so a killed process never leaves it
 *               truncated; a missing/empty/corrupt file restarts from [].
 *               Defaults next to --log as crm-leads-enrich-payloads.json.
 *               This file intentionally contains full contact values (email/
 *               phone/etc.) as sent - it is a local audit log, never a
 *               delivery target, and is covered by .gitignore's logs/ rule.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { URL } = require("url");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Contract-allowed top-level keys - only these are ever sent. This is every
// column in schemas/CRM_Leads_Field_Reference.json that enrichment could
// plausibly ever have real evidence for (from the scraped LinkedIn page,
// its profile hop, or its company About-tab hop), plus `lead_source` and
// `linkedin` per explicit instruction below - see
// schemas/crm_leads_enrich_mapping.sql for the per-field rationale. A key
// missing from this set is stripped before the request, not merely ignored
// on the far end.
//
// `job_posting_url` is still the one column deliberately EXCLUDED even
// though it's a valid CRM_Leads column - it is the identity of the row
// itself (which URL it was inserted from) and is never rewritten.
//
// `lead_source` is always DERIVED here, from the lead's own `job_posting_url`
// (passed via --job-posting-url, never part of the patch body itself) matched
// against a domain pattern and looked up by label in the reference file's own
// `lead_source` enum - see classifyLeadSourceId() below - overriding whatever
// crm-leads-patch.md passed in the body. This is deliberately NOT a bare
// hardcoded constant: the URL is actually checked, so a lead whose
// job_posting_url doesn't confidently match a known platform gets no
// `lead_source` in the patch at all, rather than a guessed value.
//
// `linkedin` is BOTH a scrape source (lead-url-enrich.md treats the lead's
// existing value as one more candidate URL to open, alongside
// job_posting_url and lead_source_description.source_urls - it can hold a
// post link rather than a resolved profile) AND, per explicit instruction, a
// write target: once a lead's poster identity is confidently resolved (the
// same identity-resolution rules that gate firstname/lastname/title), its
// own LinkedIn profile URL is written back here - the actual person, not
// whatever link the row happened to be inserted with. Ordinary merge-only
// judgement (never regress a real value, never invent one) applies exactly
// as it does to any other identity field - crm-leads-patch.md decides this
// value, this file only validates its shape.
//
// `industry`, `country`, and `state` are UUID lookup columns - the reference
// file's own enumerated `possible_values` (id + label) is the only valid set
// of values, checked generically in checkValue() below. crm-leads-patch.md
// must send the matching **id**, never the label text, and must omit the
// field entirely on anything short of a confident match (see
// crm_leads_enrich_mapping.sql's note on `state`'s duplicate labels).
const ALLOWED_TOP_KEYS = new Set([
  "organization_name",
  "website",
  "organization_linkedin",
  "industry",
  "employees",
  "firstname",
  "lastname",
  "title",
  "linkedin",
  "lead_source",
  "description",
  "primary_email",
  "secondary_email",
  "phone",
  "mobile",
  "whatsapp",
  "google_chat",
  "instagram",
  "facebook",
  "teams_id",
  "street",
  "city",
  "zipcode",
  "country",
  "state",
  "tags",
  "lead_source_description",
]);

// Domain patterns this flow can confidently map onto one of
// schemas/CRM_Leads_Field_Reference.json's lead_source.possible_values
// LABELS (the id is looked up from that same file, never hardcoded, so a
// CRM-side id change never goes stale here). Checked in order; the first
// match wins. Everything else in that enum (BTS-2023, Employee Referral,
// Web Research, Advertisement, Sales Email Alias, Trade Show, ...) has no
// URL-derivable signal at all and is never guessed at.
const LEAD_SOURCE_URL_PATTERNS = [
  { label: "LinkedIn", pattern: /linkedin\.com|lnkd\.in/i },
  { label: "Twitter", pattern: /(^|\.)twitter\.com|(^|\.)x\.com|(^|\.)t\.co/i },
  { label: "Facebook", pattern: /facebook\.com|fb\.com/i },
];

// Resolves `lead_source`'s id from the lead's own job_posting_url, never from
// agent judgement. Returns null (never a guess) when the URL is empty, the
// literal "not available" sentinel, or matches none of the known platform
// patterns above - a lead like that simply gets no `lead_source` in its
// patch, exactly like any other field with no confident evidence.
function classifyLeadSourceId(jobPostingUrl, reference) {
  const url = String(jobPostingUrl || "").trim();
  if (!url || url.toLowerCase() === "not available") return null;
  const spec = reference.get("lead_source");
  if (!spec || !Array.isArray(spec.possibleValues)) return null;
  for (const { label, pattern } of LEAD_SOURCE_URL_PATTERNS) {
    if (pattern.test(url)) {
      const match = spec.possibleValues.find((p) => p && p.value === label);
      if (match) return match.id;
    }
  }
  return null;
}

// The CRM's own field catalogue - column type, validation regex, and (for
// lookup columns) the enumerated id/value list - lives here. crm-leads-patch.md
// decides *which* allow-listed fields to send; this file is where each value
// is checked against the column it targets *before* the single PATCH, so a
// value Directus would reject (a range string in an Integer column, a name
// with characters the column's regex forbids, a non-array `tags`) is dropped
// and reported as `invalid_keys` rather than turned into an HTTP 4xx.
const FIELD_REFERENCE_PATH = path.resolve(__dirname, "..", "schemas", "CRM_Leads_Field_Reference.json");

function loadFieldReference() {
  const arr = JSON.parse(fs.readFileSync(FIELD_REFERENCE_PATH, "utf8"));
  if (!Array.isArray(arr)) throw new Error("Field reference is not a JSON array.");
  const map = new Map();
  for (const entry of arr) {
    if (!entry || typeof entry.column_name !== "string") continue;
    let regex = null;
    if (typeof entry.validation === "string") {
      // Stored as e.g.  "Regex -  ^[a-zA-Z ]*$"
      const m = entry.validation.match(/Regex\s*-\s*(.+)$/i);
      if (m) {
        try {
          regex = new RegExp(m[1].trim());
        } catch {
          regex = null; // an unparseable pattern is treated as "no regex"
        }
      }
    }
    map.set(entry.column_name, {
      type: String(entry.field_type || "").toLowerCase(),
      regex,
      possibleValues: entry.possible_values,
    });
  }
  return map;
}

// Returns { ok: true, value } (value possibly coerced, e.g. a clean numeric
// string -> Number for an Integer column) or { ok: false, reason } when the
// value does not fit the column's type / enumerated set / validation regex.
// An explicit null is always shape-valid (a deliberate "clear this field").
function checkValue(spec, value) {
  if (!spec) return { ok: false, reason: "no field-reference entry for this column" };
  if (value === null) return { ok: true, value: null };

  const t = spec.type;

  if (t === "string" || t === "text") {
    if (typeof value !== "string") return { ok: false, reason: `expected a string for a ${t} column` };
  } else if (t === "integer") {
    let n = value;
    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) n = Number(value.trim());
    if (!Number.isInteger(n)) return { ok: false, reason: "expected an integer" };
    value = n;
  } else if (t === "boolean") {
    if (typeof value !== "boolean") return { ok: false, reason: "expected a boolean" };
  } else if (t === "date") {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return { ok: false, reason: "expected a YYYY-MM-DD date string" };
    }
  } else if (t === "uuid") {
    if (typeof value !== "string" || !UUID_RE.test(value)) return { ok: false, reason: "expected a UUID string" };
  } else if (t === "json") {
    const wantsArray =
      spec.possibleValues && !Array.isArray(spec.possibleValues) && spec.possibleValues.type === "array";
    if (wantsArray) {
      if (!Array.isArray(value)) return { ok: false, reason: "expected a JSON array" };
      if (!value.every((v) => typeof v === "string")) return { ok: false, reason: "expected an array of strings" };
    } else if (typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, reason: "expected a JSON object" };
    }
  }

  // Enumerated lookup column: the value must be one of the listed ids/values.
  if (Array.isArray(spec.possibleValues) && spec.possibleValues.length > 0) {
    const allowed = spec.possibleValues.map((p) => (p && typeof p === "object" && "id" in p ? p.id : p));
    if (!allowed.includes(value)) return { ok: false, reason: "not one of the column's allowed options" };
  }

  // Column-level validation regex (only meaningful for a non-empty string).
  if (spec.regex && typeof value === "string" && value !== "" && !spec.regex.test(value)) {
    return { ok: false, reason: `fails the column's validation pattern ${spec.regex}` };
  }

  return { ok: true, value };
}

// Splits an already-allow-listed body into the fields that fit their columns
// (with any coercions applied) and a list of { key, reason } for those that
// don't. Nothing that fails here is ever sent.
function validateAgainstReference(allowed, reference) {
  const valid = {};
  const invalid = [];
  for (const [key, rawValue] of Object.entries(allowed)) {
    const result = checkValue(reference.get(key), rawValue);
    if (result.ok) valid[key] = result.value;
    else invalid.push({ key, reason: result.reason });
  }
  return { valid, invalid };
}

function parseArgs(argv) {
  const args = { log: "./logs/crm-leads-enrich-responses.md" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--id") args.id = argv[++i];
    else if (argv[i] === "--log") args.log = argv[++i];
    else if (argv[i] === "--payload-log") args.payloadLog = argv[++i];
    else if (argv[i] === "--job-posting-url") args.jobPostingUrl = argv[++i];
    else if (argv[i] === "--timezone") args.timezone = argv[++i];
    else if (argv[i] === "--dry-run") args.dryRun = true;
  }
  return args;
}

function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === "'" || value[0] === '"')) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

function cell(value) {
  if (value === null || value === undefined || value === "") return "—";
  return String(value).replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|");
}

function resolveTimezone(value) {
  const name = value || process.env.TZ;
  if (name) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: name });
      return name;
    } catch {
      throw new Error(`Invalid IANA time zone: ${name}`);
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function now(zone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "00";
  return {
    date: `${get("day")}-${get("month")}-${get("year")}`,
    time: `${get("hour")}:${get("minute")}:${get("second")}`,
  };
}

function readStdinJson() {
  const raw = fs.readFileSync(0, "utf8");
  if (!raw.trim()) throw new Error("Expected a non-empty JSON object on stdin.");
  const body = JSON.parse(raw);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Input must be a single JSON object (the patch body).");
  }
  return body;
}

function sanitizeBody(body) {
  const clean = {};
  const dropped = [];
  for (const [key, value] of Object.entries(body)) {
    if (ALLOWED_TOP_KEYS.has(key)) clean[key] = value;
    else dropped.push(key);
  }
  return { clean, dropped };
}

function requestJson(method, targetUrl, headers, bodyString) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      reject(new Error(`Invalid URL: ${targetUrl}`));
      return;
    }
    const lib = parsed.protocol === "http:" ? http : https;
    const req = lib.request(parsed, { method, headers }, (res) => {
      let respBody = "";
      res.on("data", (chunk) => (respBody += chunk));
      res.on("end", () => {
        let json = null;
        try {
          json = respBody ? JSON.parse(respBody) : null;
        } catch {
          // leave json null; caller sees status + raw
        }
        resolve({ status: res.statusCode, json, raw: respBody });
      });
    });
    req.on("error", reject);
    if (bodyString) req.write(bodyString);
    req.end();
  });
}

function ensureLogHeader(logPath) {
  if (fs.existsSync(logPath)) return;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(
    logPath,
    "# CRM leads enrich - PATCH log\n\n" +
      "| Date | Time | Lead ID | Fields patched | Result | HTTP status | Duration (ms) |\n" +
      "|---|---|---|---|---|---|---:|\n"
  );
}

function appendLogRow(logPath, row) {
  ensureLogHeader(logPath);
  fs.appendFileSync(
    logPath,
    `| ${cell(row.date)} | ${cell(row.time)} | ${cell(row.id)} | ${cell(row.fields)} | ${cell(row.result)} | ${cell(row.status)} | ${cell(row.durationMs)} |\n`
  );
}

// Default payload-audit path: alongside the markdown response log, so the
// two always land in the same logs/ dir even when --log is overridden.
function defaultPayloadLog(mdLogPath) {
  return path.join(path.dirname(mdLogPath || "./logs"), "crm-leads-enrich-payloads.json");
}

// Appends the exact request body of one real PATCH attempt as one element of
// a JSON array file. Read the existing array, push, and rewrite it atomically
// (temp file + rename) so a process killed mid-write can never leave the file
// truncated or invalid. A missing, empty, or unparseable file is treated as
// an empty array rather than a hard error. This is the payload audit trail:
// what was sent, to which row, when (UTC `logged_at` + resolved-local
// date/time/zone), and how it landed. Never called on --dry-run. A failure
// here is swallowed on purpose - a missing audit entry must never turn a
// confirmed PATCH into a reported failure, and the markdown log still carries
// the attempt's row.
function appendPayloadRecord(payloadLogPath, record) {
  try {
    fs.mkdirSync(path.dirname(payloadLogPath), { recursive: true });
    let records = [];
    try {
      const existing = fs.readFileSync(payloadLogPath, "utf8");
      if (existing.trim()) {
        const parsed = JSON.parse(existing);
        if (Array.isArray(parsed)) records = parsed;
      }
    } catch {
      // No file yet, or it was empty/corrupt - start a fresh array.
    }
    records.push(record);
    const tmpPath = `${payloadLogPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(records, null, 2) + "\n");
    fs.renameSync(tmpPath, payloadLogPath);
  } catch {
    // Intentionally ignored - see comment above.
  }
}

async function main() {
  loadEnv(path.resolve(__dirname, "..", ".env"));
  const args = parseArgs(process.argv.slice(2));
  const payloadLog = args.payloadLog || defaultPayloadLog(args.log);
  const startMs = Date.now();

  if (!args.id || !UUID_RE.test(args.id)) {
    console.log(JSON.stringify({ commit_state: "failed", id: args.id || null, status: null, response: null, error: "Missing or invalid --id (expected a UUID)." }));
    process.exitCode = 1;
    return;
  }

  let body;
  try {
    body = readStdinJson();
  } catch (error) {
    console.log(JSON.stringify({ commit_state: "failed", id: args.id, status: null, response: null, error: String(error) }));
    process.exitCode = 1;
    return;
  }

  const { clean: allowed, dropped } = sanitizeBody(body);

  let reference;
  try {
    reference = loadFieldReference();
  } catch (error) {
    console.log(JSON.stringify({
      commit_state: "failed", id: args.id, status: null, response: null,
      error: `schemas/CRM_Leads_Field_Reference.json could not be loaded (${String(error)}) - refusing to PATCH unvalidated.`,
      dropped_keys: dropped, invalid_keys: [],
    }));
    process.exitCode = 1;
    return;
  }

  const { valid: clean, invalid } = validateAgainstReference(allowed, reference);

  // `lead_source` is always DERIVED from the lead's own job_posting_url, never
  // taken from crm-leads-patch.md's body - see classifyLeadSourceId() and
  // ALLOWED_TOP_KEYS's comment. A URL that doesn't confidently match a known
  // platform simply means no `lead_source` in this patch - never a guess.
  const derivedLeadSource = classifyLeadSourceId(args.jobPostingUrl, reference);
  if (derivedLeadSource) clean.lead_source = derivedLeadSource;
  else delete clean.lead_source;

  if (Object.keys(clean).length === 0) {
    console.log(JSON.stringify({
      commit_state: "failed", id: args.id, status: null, response: null,
      error: "Patch body had no valid fields after allow-list + field-reference validation.",
      dropped_keys: dropped, invalid_keys: invalid,
    }));
    process.exitCode = 1;
    return;
  }

  const baseUrl = (process.env.CRM_ENRICH_API_URL || "").trim().replace(/\/+$/, "");
  const token = (process.env.CRM_ENRICH_API_TOKEN || "").trim();
  const targetUrl = `${baseUrl}/items/crm_leads/${args.id}`;

  if (args.dryRun) {
    console.log(
      JSON.stringify({
        commit_state: "dry-run",
        id: args.id,
        status: null,
        response: { target: targetUrl, body: clean, dropped_keys: dropped, invalid_keys: invalid },
        error: null,
        dropped_keys: dropped,
        invalid_keys: invalid,
      })
    );
    return;
  }

  if (!baseUrl || !token) {
    console.log(JSON.stringify({ commit_state: "failed", id: args.id, status: null, response: null, error: "CRM_ENRICH_API_URL and/or CRM_ENRICH_API_TOKEN is not set." }));
    process.exitCode = 1;
    return;
  }

  let zone;
  try {
    zone = resolveTimezone(args.timezone);
  } catch (error) {
    console.log(JSON.stringify({ commit_state: "failed", id: args.id, status: null, response: null, error: String(error) }));
    process.exitCode = 1;
    return;
  }

  const bodyString = JSON.stringify(clean);
  let result;
  try {
    result = await requestJson(
      "PATCH",
      targetUrl,
      {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyString),
      },
      bodyString
    );
  } catch (error) {
    const { date, time } = now(zone);
    const durationMs = Date.now() - startMs;
    appendLogRow(args.log, {
      date, time, id: args.id, fields: Object.keys(clean).join(", "),
      result: "unknown", status: "transport-error", durationMs,
    });
    appendPayloadRecord(payloadLog, {
      logged_at: new Date().toISOString(),
      date, time, timezone: zone,
      id: args.id, method: "PATCH", target: targetUrl,
      fields: Object.keys(clean), dropped_keys: dropped, invalid_keys: invalid, payload: clean,
      commit_state: "unknown", http_status: null, duration_ms: durationMs,
      error: String(error),
    });
    console.log(JSON.stringify({ commit_state: "unknown", id: args.id, status: null, response: null, error: String(error), dropped_keys: dropped, invalid_keys: invalid }));
    process.exitCode = 1;
    return;
  }

  const { date, time } = now(zone);
  const durationMs = Date.now() - startMs;
  const success = result.status >= 200 && result.status < 300;
  appendLogRow(args.log, {
    date, time, id: args.id, fields: Object.keys(clean).join(", "),
    result: success ? "confirmed" : "failed", status: result.status, durationMs,
  });
  appendPayloadRecord(payloadLog, {
    logged_at: new Date().toISOString(),
    date, time, timezone: zone,
    id: args.id, method: "PATCH", target: targetUrl,
    fields: Object.keys(clean), dropped_keys: dropped, invalid_keys: invalid, payload: clean,
    commit_state: success ? "confirmed" : "failed",
    http_status: result.status, duration_ms: durationMs,
    error: success ? null : `HTTP ${result.status}`,
  });

  console.log(
    JSON.stringify({
      commit_state: success ? "confirmed" : "failed",
      id: args.id,
      status: result.status,
      response: success ? (result.json?.data ?? null) : (result.raw || "").slice(0, 500),
      error: success ? null : `HTTP ${result.status}`,
      dropped_keys: dropped,
      invalid_keys: invalid,
    })
  );
  if (!success) process.exitCode = 1;
}

main();
