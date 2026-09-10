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
 * Usage:
 *   node crm-leads-update.js --id <lead-id> --log <path> --timezone <tz> [--dry-run]
 * (complete validated JSON patch-body on stdin)
 *
 * --dry-run prints the resolved target + body without sending anything -
 * this flow writes to CRM rows that already exist, unlike an insert, so it
 * is worth confirming the exact PATCH before the first real send.
 *
 * Output: one JSON object on stdout - { commit_state, id, status, response,
 * error }. commit_state is "confirmed", "failed", "unknown", or "dry-run".
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { URL } = require("url");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Contract-allowed top-level keys - only these are ever sent. Everything
// else (FK lookup ids the model can't produce, or fields this flow should
// never touch, like job_posting_url/is_ai_generated/primary_bde/
// recommended_for_outreach/lead_status) is stripped before the request, not
// merely ignored on the far end - see LINKEDIN-ENRICH-Workflow.md's PATCH
// contract.
//
// `linkedin` is deliberately NOT in this list. It is a SOURCE the scraper
// reads from (lead-url-enrich.md treats it as one more candidate URL to
// open, alongside job_posting_url and lead_source_description.source_urls -
// it can hold a post link just as easily as a resolved profile URL), never a
// derived fact this flow writes. Enforced here in code, not just in agent
// instructions, the same hard-guarantee treatment as job_posting_url/
// is_ai_generated - even a confused agent cannot get this key into a
// request, because it never reaches the HTTP call in the first place.
const ALLOWED_TOP_KEYS = new Set([
  "organization_name",
  "website",
  "organization_linkedin",
  "employees",
  "firstname",
  "lastname",
  "title",
  "description",
  "primary_email",
  "secondary_email",
  "phone",
  "mobile",
  "whatsapp",
  "city",
  "street",
  "zipcode",
  "tags",
  "lead_source_description",
]);

function parseArgs(argv) {
  const args = { log: "./logs/crm-leads-enrich-responses.md" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--id") args.id = argv[++i];
    else if (argv[i] === "--log") args.log = argv[++i];
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

async function main() {
  loadEnv(path.resolve(__dirname, "..", ".env"));
  const args = parseArgs(process.argv.slice(2));
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

  const { clean, dropped } = sanitizeBody(body);
  if (Object.keys(clean).length === 0) {
    console.log(JSON.stringify({ commit_state: "failed", id: args.id, status: null, response: null, error: "Patch body had no allow-listed fields after sanitizing.", dropped_keys: dropped }));
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
        response: { target: targetUrl, body: clean, dropped_keys: dropped },
        error: null,
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
    appendLogRow(args.log, {
      date, time, id: args.id, fields: Object.keys(clean).join(", "),
      result: "unknown", status: "transport-error", durationMs: Date.now() - startMs,
    });
    console.log(JSON.stringify({ commit_state: "unknown", id: args.id, status: null, response: null, error: String(error) }));
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

  console.log(
    JSON.stringify({
      commit_state: success ? "confirmed" : "failed",
      id: args.id,
      status: result.status,
      response: success ? (result.json?.data ?? null) : (result.raw || "").slice(0, 500),
      error: success ? null : `HTTP ${result.status}`,
    })
  );
  if (!success) process.exitCode = 1;
}

main();
