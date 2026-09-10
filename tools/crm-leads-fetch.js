#!/usr/bin/env node
/**
 * Fetches AI-generated crm_leads rows created on one calendar day (UTC), via
 * Directus's native REST endpoint (/items/crm_leads) - a plain Bearer token,
 * not the custom x-crm-leads-secret header a sibling project's insert flow
 * uses. Dependency-free (fs/https/http only, no package install), same
 * convention as every other tool in this project.
 *
 * The day boundary matches Directus's own filter shape exactly:
 *   filter[date_created][_gte]=<day>T00:00:00.000Z
 *   filter[date_created][_lt]=<day+1>T00:00:00.000Z
 * `--date` defaults to today (UTC) computed fresh at run time - a scheduled
 * daily run always resolves to whichever day it actually executes on, never
 * a hardcoded date. Pass an explicit `--date YYYY-MM-DD` to reprocess a past
 * day instead.
 *
 * Usage:
 *   node crm-leads-fetch.js [--date YYYY-MM-DD] [--limit N]
 *
 * `--limit` defaults to -1 (Directus's "no cap" value, matching the
 * dashboard's own default for this filter) - pass a positive number only to
 * bound a test run.
 *
 * Output: one JSON object on stdout - { leads: [...], count, fetched_at,
 * date, filter, error }. `leads` is the raw Directus row array - every
 * column crm_leads has, including lead_source_description as a parsed object
 * - so lead-url-enrich.md can see exactly what is already known per lead
 * before deciding what still needs enriching.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { URL } = require("url");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--date") args.date = argv[++i];
    else if (argv[i] === "--limit") args.limit = argv[++i];
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

// Today, UTC, as YYYY-MM-DD - computed fresh every call, never cached, so a
// scheduled run always resolves to the day it actually executes on.
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function dayBoundsUtc(dateStr) {
  const start = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) {
    throw new Error(`Invalid --date value: ${dateStr} (expected YYYY-MM-DD)`);
  }
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { gte: start.toISOString(), lt: end.toISOString() };
}

function requestJson(targetUrl, headers) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      reject(new Error(`Invalid URL: ${targetUrl}`));
      return;
    }
    const lib = parsed.protocol === "http:" ? http : https;
    const req = lib.request(
      parsed,
      { method: "GET", headers },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          let json = null;
          try {
            json = body ? JSON.parse(body) : null;
          } catch {
            // fall through with json = null; caller sees status + raw body
          }
          resolve({ status: res.statusCode, json, raw: body });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function main() {
  loadEnv(path.resolve(__dirname, "..", ".env"));
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();

  const dateStr = args.date || todayUtc();
  if (args.date && !DATE_RE.test(args.date)) {
    console.log(
      JSON.stringify({
        leads: [], count: 0, fetched_at: startedAt, date: args.date, filter: null,
        error: `Invalid --date value: ${args.date} (expected YYYY-MM-DD)`,
      })
    );
    process.exitCode = 1;
    return;
  }

  const baseUrl = (process.env.CRM_ENRICH_API_URL || "").trim().replace(/\/+$/, "");
  const token = (process.env.CRM_ENRICH_API_TOKEN || "").trim();

  if (!baseUrl || !token) {
    console.log(
      JSON.stringify({
        leads: [], count: 0, fetched_at: startedAt, date: dateStr, filter: null,
        error: "CRM_ENRICH_API_URL and/or CRM_ENRICH_API_TOKEN is not set (checked process env, then .env).",
      })
    );
    process.exitCode = 1;
    return;
  }

  const { gte, lt } = dayBoundsUtc(dateStr);
  // -1 is Directus's own "no cap" value, matching the dashboard's default
  // for this exact filter - not an arbitrary large number.
  const limit = args.limit !== undefined ? Number(args.limit) : -1;

  const query = new URLSearchParams();
  query.set("filter[is_ai_generated][_eq]", "true");
  query.set("filter[date_created][_gte]", gte);
  query.set("filter[date_created][_lt]", lt);
  query.set("fields", "*");
  query.set("sort", "-date_created");
  query.set("limit", String(limit));

  const targetUrl = `${baseUrl}/items/crm_leads?${query.toString()}`;
  const filter = { is_ai_generated: true, date_created_gte: gte, date_created_lt: lt, limit };

  try {
    const { status, json, raw } = await requestJson(targetUrl, {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    });

    if (status < 200 || status >= 300) {
      console.log(
        JSON.stringify({
          leads: [], count: 0, fetched_at: startedAt, date: dateStr, filter,
          error: `HTTP ${status}: ${(raw || "").slice(0, 500)}`,
        })
      );
      process.exitCode = 1;
      return;
    }

    const leads = Array.isArray(json?.data) ? json.data : [];
    console.log(
      JSON.stringify({
        leads, count: leads.length, fetched_at: startedAt, date: dateStr, filter, error: null,
      })
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        leads: [], count: 0, fetched_at: startedAt, date: dateStr, filter, error: String(error),
      })
    );
    process.exitCode = 1;
  }
}

main();
