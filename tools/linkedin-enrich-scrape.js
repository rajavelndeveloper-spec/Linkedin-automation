#!/usr/bin/env node
/**
 * Deterministic LinkedIn direct-URL scraper for /enrich - authenticated
 * session, no LLM in the loop. This does not search LinkedIn: it is handed
 * the exact job or post URL already stored on an existing crm_leads row
 * (job_posting_url, or one of lead_source_description.source_urls) and just
 * opens it, the same way a person clicking that link would. Judgment (which
 * field means what, whether a reshare's original poster is the real contact,
 * what counts as "not available") belongs to lead-url-enrich.md, not here -
 * this tool only returns what is literally on the page.
 *
 * Usage:
 *   node linkedin-enrich-scrape.js --url "<job or post URL>" [--hops profile,company]
 *
 * Output: one JSON object on stdout - { url, type, main_text, poster,
 * reposted_by, original_post, company_link, links, profile_page (with
 * main_text and contact_info_text), job_page (with main_text and
 * company_link), company_page, hops_done, extraction_uncertain,
 * session_expired, selectors_suspect, started_at, finished_at, duration_ms,
 * error }.
 *
 * `hops` is a bounded allowance, not a target: at most 4 additional page
 * loads beyond the source URL's own (5 total per invocation) - the profile
 * hop costs 2 (the main profile page, then its Contact info overlay), the
 * company hop costs 1 (forced onto the About tab specifically, see
 * toCompanyAboutUrl), and for a POST whose only route to the employer is an
 * embedded "View job" card, one extra load opens that job page to read the
 * company link off it (scrapeEmbeddedJob) before the company hop runs - the
 * same company facts a type:"job" source URL would have given directly. That
 * job hop is taken only when the post carries no /company/ link of its own.
 * See LINKEDIN-ENRICH-CONFIG.md. Pass an empty `--hops` to scrape only the
 * source page.
 *
 * SELECTOR CONFIDENCE - read before trusting this blindly. The Jobs/Posts
 * scraper in the sibling ai-automation-system project captured its selectors
 * empirically against a live authenticated page. The poster/reshare
 * extraction here could not be verified the same way when first written (no
 * live signed-in session available while writing it), so it deliberately
 * leans on the most class-hash-resistant signals: raw innerText,
 * href-pattern link matching, and the "Open control menu for post by
 * <Name>" aria-label (the one accessibility attribute that survives
 * LinkedIn's class-hashing on the Posts surface - confirmed in that sibling
 * project's own scraper). It reports `extraction_uncertain: true` when
 * everything comes up empty so a human can tell "genuinely nothing on this
 * page" from "selectors need a real capture pass."
 *
 * The COMPANY ABOUT TAB is the one part of this file that IS now empirically
 * confirmed (2026-09-09, a live company page): it renders plain labeled text
 * directly in the body - "Website", "Phone", "Industry", "Company size"
 * ("51-200 employees" shape), "Headquarters" - no lazy-loading, no modal.
 * `toCompanyAboutUrl` forces navigation onto this exact tab rather than
 * whatever generic /company/ link was found (usually the Home tab, which
 * doesn't carry these fields). Poster/reshare detection and the profile
 * Contact info overlay remain unverified against a live page - spot-check
 * and tighten those specifically if `extraction_uncertain` looks high on
 * posts/profiles in practice - see LINKEDIN-ENRICH-Workflow.md's Maintenance
 * section.
 *
 * JOB-PAGE POSTER: a job listing's "hiring team"/recruiter card has no
 * aria-label to lean on the way Posts does (extractJobPoster's two-tier
 * heuristic: a nearby-text phrase match first, a positional first-/in/-link
 * fallback second, both tagged with a `confidence` field) - this is the
 * lowest-confidence part of this file and the first place to tighten against
 * a real page if `poster.confidence` on job leads looks wrong in practice.
 *
 * LAZY CONTENT: settleLazyContent scrolls the page through before every text
 * read, because LinkedIn's "About the company" panel and a profile's "About"
 * section often don't exist in the DOM at all until scrolled into view once -
 * the same virtualization problem the sibling project's Jobs search worked
 * around with hydrateJobCards.
 */

const { chromium } = require("playwright");
const path = require("path");

const PROFILE_DIR = process.env.LINKEDIN_CHROME_PROFILE || "D:/chrome-profiles/enrich-linkedin";
const NAV_TIMEOUT_MS = 30_000;
const MAX_TEXT_CHARS = 12000;
const MAX_LINKS = 40;
const POST_MENU_SELECTOR = 'button[aria-label^="Open control menu for post by"]';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      args[key] = value;
    }
  }
  return args;
}

// Text-based on purpose, not selector-based - LinkedIn's human-readable copy
// for a logged-out gate is far more stable than any CSS class, and this
// exact check is already proven in the sibling project's discovery scraper.
async function isLoggedOut(page) {
  try {
    const bodyText = await page.evaluate(() => document.body.innerText || "");
    return /sign in to view more|join now|sign in\s*$/im.test(bodyText.slice(0, 3000));
  } catch {
    return false;
  }
}

function classifyEnrichUrl(url) {
  if (/\/jobs\/view\//i.test(url)) return "job";
  if (/\/posts\/|\/feed\/update\/|lnkd\.in\//i.test(url)) return "post";
  if (/\/in\//i.test(url)) return "profile";
  if (/\/company\//i.test(url)) return "company";
  return "unknown";
}

// Scrolls the page in steps before reading it. LinkedIn lazily renders
// below-the-fold sections - a job page's "About the company" panel and a
// profile's "About" section often don't exist in the DOM at all until
// scrolled into view at least once, the same virtualization problem the
// sibling project's Jobs search had to work around with hydrateJobCards.
// Best-effort: a failure here still falls through to reading whatever is
// already in the DOM.
async function settleLazyContent(page) {
  try {
    await page.evaluate(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const step = Math.max(400, Math.floor(document.body.scrollHeight / 6));
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await sleep(150);
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(500);
  } catch {
    // Best-effort only - proceed with whatever is already rendered.
  }
}

async function extractMainText(page) {
  await settleLazyContent(page);
  try {
    const text = await page.evaluate(() => document.body.innerText || "");
    return text.slice(0, MAX_TEXT_CHARS);
  } catch {
    return "";
  }
}

// Generic, href-pattern based (no class names) so it survives markup churn
// the same way isLoggedOut does.
async function extractRelevantLinks(page) {
  try {
    const rawLinks = await page.$$eval("a[href]", (nodes) =>
      nodes
        .map((n) => ({ href: n.getAttribute("href") || "", text: (n.textContent || "").trim() }))
        .filter((l) => l.href)
    );
    const seen = new Set();
    const kept = [];
    for (const link of rawLinks) {
      let absolute;
      try {
        absolute = new URL(link.href, "https://www.linkedin.com").href.split("?")[0];
      } catch {
        continue;
      }
      const isProfile = /linkedin\.com\/in\//i.test(absolute);
      const isCompany = /linkedin\.com\/company\//i.test(absolute);
      const isJob = /linkedin\.com\/jobs\/view\//i.test(absolute);
      const isExternal = !/linkedin\.com/i.test(absolute) && /^https?:\/\//i.test(absolute);
      if (!isProfile && !isCompany && !isJob && !isExternal) continue;
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      kept.push({
        href: absolute,
        text: link.text.slice(0, 120),
        kind: isProfile ? "profile" : isCompany ? "company" : isJob ? "job" : "external",
      });
      if (kept.length >= MAX_LINKS) break;
    }
    return kept;
  } catch {
    return [];
  }
}

// A reshare renders the resharer's control-menu button at the top level with
// an embedded original post inside it; the embedded post is not its own
// separate feed item, so it has no control-menu button of its own. Detect
// the reshare from the human-readable "reposted this"/"shared this" text
// LinkedIn shows above the embed, then take the LAST distinct profile
// link/text block inside the container as the embedded original - the
// resharer's own link/name sits nearest the control menu, first.
async function extractPostIdentities(page) {
  const result = { poster: null, reposted_by: null, original_post: null };
  try {
    const menuButton = page.locator(POST_MENU_SELECTOR).first();
    const count = await page.locator(POST_MENU_SELECTOR).count();
    if (count === 0) return result;

    const topPoster = await menuButton.evaluate((el) => {
      const name = (el.getAttribute("aria-label") || "")
        .replace(/^Open control menu for post by /, "")
        .trim();
      let container = el;
      for (let i = 0; i < 10 && container.parentElement; i++) {
        container = container.parentElement;
        if (container.querySelector('[data-testid="expandable-text-box"]')) break;
      }
      const textEl = container.querySelector('[data-testid="expandable-text-box"]');
      const bodyText = container.innerText || "";
      const isReshare = /reposted this|shared this/i.test(bodyText.slice(0, 400));
      const profileLink = container.querySelector('a[href*="/in/"]');
      return {
        name,
        text: textEl?.textContent?.trim() ?? "",
        profileUrl: profileLink ? profileLink.href : null,
        isReshare,
      };
    });

    if (!topPoster.isReshare) {
      result.poster = { name: topPoster.name, profileUrl: topPoster.profileUrl, text: topPoster.text };
      return result;
    }

    result.reposted_by = { name: topPoster.name, profileUrl: topPoster.profileUrl };

    const original = await menuButton.evaluate((el) => {
      let container = el;
      for (let i = 0; i < 10 && container.parentElement; i++) container = container.parentElement;
      const profileLinks = Array.from(container.querySelectorAll('a[href*="/in/"]'));
      const textBoxes = Array.from(container.querySelectorAll('[data-testid="expandable-text-box"]'));
      const originalLink = profileLinks.length > 1 ? profileLinks[profileLinks.length - 1] : null;
      const originalText = textBoxes.length > 1 ? textBoxes[textBoxes.length - 1] : textBoxes[0];
      return {
        profileUrl: originalLink ? originalLink.href : null,
        name: originalLink ? (originalLink.textContent || "").trim() : null,
        text: originalText ? (originalText.textContent || "").trim() : "",
      };
    });

    if (original.text || original.profileUrl) {
      result.original_post = {
        text: original.text,
        poster: { name: original.name, profileUrl: original.profileUrl },
      };
    }
  } catch {
    // Leave result all-null - a failed identity read surfaces as
    // extraction_uncertain below, never a thrown error.
  }
  return result;
}

// A job listing's "hiring team"/recruiter card has no aria-label technique
// to lean on the way Posts does, so this is a lower-confidence, two-tier
// heuristic: prefer a /in/ link whose nearby text explicitly says this
// person is connected to hiring for the role (LinkedIn's own human-readable
// copy - "is hiring for this role", "Meet the hiring team"), and only fall
// back to "the first /in/ link on the page" (a positional guess - a job
// page's hiring-team card typically renders before any "Similar jobs"/
// "People also viewed" section, but this is not text-confirmed) when no
// phrase match exists. Both cases are tagged with `confidence` so
// lead-url-enrich.md can weigh a positional guess lower than a phrase match.
async function extractJobPoster(page) {
  try {
    return await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/in/"]'));
      if (links.length === 0) return null;

      for (const link of links) {
        let node = link;
        let nearbyText = "";
        for (let i = 0; i < 6 && node; i++) {
          nearbyText += " " + (node.innerText || node.textContent || "");
          node = node.parentElement;
        }
        if (/hiring (for|team)|meet the hiring team|posted this job/i.test(nearbyText)) {
          return {
            name: (link.textContent || "").trim(),
            profileUrl: link.href,
            confidence: "hiring-team-phrase",
          };
        }
      }

      return {
        name: (links[0].textContent || "").trim(),
        profileUrl: links[0].href,
        confidence: "first-profile-link",
      };
    });
  } catch {
    return null;
  }
}

// The company hop must land on the About tab specifically, not whatever
// generic /company/<slug>/... link was found in the page (usually the Home
// tab). CONFIRMED against a live page (2026-09-09): the About tab renders
// its facts as plain labeled text directly in the body - "Website",
// "Phone", "Industry", "Company size" ("51-200 employees"), "Headquarters" -
// no lazy-loading, no modal, just innerText. This is the one part of this
// file's extraction that IS empirically verified, unlike the poster/reshare
// heuristics noted in the file header.
function toCompanyAboutUrl(href) {
  const match = href.match(/linkedin\.com\/company\/([^/?#]+)/i);
  if (!match) return href;
  return `https://www.linkedin.com/company/${match[1]}/about/`;
}

// LinkedIn profiles keep email/phone/website (when the owner chose to share
// them) behind a distinct "Contact info" overlay rather than on the main
// profile page - a real, directly navigable URL, not a click-only modal.
// Worth trying explicitly since it's exactly where a shared phone/email
// would be, at the cost of one extra page load within the profile hop's own
// budget (never a hop of its own). Access is still gated by the profile
// owner's sharing settings and connection degree - an inaccessible overlay
// returns whatever LinkedIn renders for that case (often just the page
// chrome), which naturally falls out of `extraction_uncertain` handling
// downstream rather than needing special-casing here.
async function fetchContactInfoText(page, profileUrl) {
  try {
    const overlayUrl = `${profileUrl.replace(/\/$/, "")}/overlay/contact-info/`;
    await page.goto(overlayUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(1000);
    if (await isLoggedOut(page)) return null;
    return (await extractMainText(page)) || null;
  } catch {
    return null;
  }
}

// A post often embeds a job as a "View job" card (/jobs/view/<id>) instead of
// linking the company directly - the company is only reachable by opening
// that job page, exactly as if the job URL had been the source URL. When a
// post carries no /company/ link of its own, open the embedded job once and
// read the company link (and the job page's own text, which carries an
// "About the company" blurb) off it, so the normal company About hop can run
// from there. One extra page load, taken only for this post-with-embedded-job
// case - a job or company source URL never needs it.
async function scrapeEmbeddedJobForCompany(page, jobUrl) {
  try {
    await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(1500);
    if (await isLoggedOut(page)) return null;
    const jobMainText = await extractMainText(page);
    const jobLinks = await extractRelevantLinks(page);
    const companyLink = jobLinks.find((l) => l.kind === "company")?.href || null;
    return { url: jobUrl, main_text: jobMainText, company_link: companyLink };
  } catch {
    return null;
  }
}

async function scrapeEnrichUrl(page, url, hops) {
  let type = classifyEnrichUrl(url);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await page.waitForTimeout(1500);

  if (await isLoggedOut(page)) {
    return {
      url, type, main_text: "", poster: null, reposted_by: null, original_post: null,
      company_link: null, links: [], profile_page: null, job_page: null, company_page: null,
      hops_done: [], extraction_uncertain: true, session_expired: true, selectors_suspect: false,
    };
  }

  const main_text = await extractMainText(page);
  const links = await extractRelevantLinks(page);

  let poster = null;
  let reposted_by = null;
  let original_post = null;

  if (type === "post" || type === "unknown") {
    const identities = await extractPostIdentities(page);
    poster = identities.poster;
    reposted_by = identities.reposted_by;
    original_post = identities.original_post;
    if (poster || reposted_by) type = "post";
  }

  if (type === "job") {
    poster = await extractJobPoster(page);
  }

  // Generic signal, not page-type-specific: the first /company/ link on the
  // page is the poster's company on a job listing and usually the author's
  // current company when LinkedIn renders one on a post.
  let companyLink = links.find((l) => l.kind === "company")?.href || null;

  const hopsDone = [];
  let profile_page = null;
  let job_page = null;
  let company_page = null;
  const profileUrl = original_post?.poster?.profileUrl || poster?.profileUrl || null;

  // Post with an embedded "View job" card but no direct company link: resolve
  // the employer through that job page first (one extra load), so the company
  // hop below has a /company/ link to work with - the same company facts a
  // type:"job" source URL would have produced directly.
  if (
    hops.includes("company") &&
    !companyLink &&
    (type === "post" || type === "unknown")
  ) {
    const embeddedJobUrl = links.find((l) => l.kind === "job")?.href || null;
    if (embeddedJobUrl) {
      job_page = await scrapeEmbeddedJobForCompany(page, embeddedJobUrl);
      if (job_page) {
        hopsDone.push("job");
        if (job_page.company_link) companyLink = job_page.company_link;
      }
    }
  }

  if (hops.includes("profile") && profileUrl) {
    try {
      await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      await page.waitForTimeout(1500);
      if (!(await isLoggedOut(page))) {
        const profileMainText = await extractMainText(page);
        const contactInfoText = await fetchContactInfoText(page, profileUrl);
        profile_page = { url: profileUrl, main_text: profileMainText, contact_info_text: contactInfoText };
        hopsDone.push("profile");
      }
    } catch {
      // A broken/unreachable profile hop is not fatal to the rest of the record.
    }
  }

  if (hops.includes("company") && companyLink) {
    const companyAboutUrl = toCompanyAboutUrl(companyLink);
    try {
      await page.goto(companyAboutUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      await page.waitForTimeout(1500);
      if (!(await isLoggedOut(page))) {
        company_page = { url: companyAboutUrl, main_text: await extractMainText(page) };
        hopsDone.push("company");
      }
    } catch {
      // Same - a failed company hop still returns everything gathered so far.
    }
  }

  const extractionUncertain = !main_text && !poster && !original_post && !companyLink;

  return {
    url, type, main_text, poster, reposted_by, original_post,
    company_link: companyLink, links, profile_page, job_page, company_page,
    hops_done: hopsDone, extraction_uncertain: extractionUncertain,
    session_expired: false, selectors_suspect: extractionUncertain,
  };
}

async function main() {
  const startMs = Date.now();
  const startedAt = new Date(startMs).toISOString();
  const args = parseArgs(process.argv.slice(2));
  const url = args.url;
  const hops = (args.hops || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (!url) {
    console.error(
      JSON.stringify({
        error: 'Usage: --url "<job or post URL>" [--hops profile,company]',
      })
    );
    process.exit(1);
  }

  const context = await chromium.launchPersistentContext(path.resolve(PROFILE_DIR), {
    channel: "chrome",
    headless: false,
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    const result = await scrapeEnrichUrl(page, url, hops);

    console.log(
      JSON.stringify({
        ...result,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startMs,
        error: null,
      })
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        url,
        type: "unknown",
        main_text: "",
        poster: null,
        reposted_by: null,
        original_post: null,
        company_link: null,
        links: [],
        profile_page: null,
        job_page: null,
        company_page: null,
        hops_done: [],
        extraction_uncertain: true,
        session_expired: false,
        selectors_suspect: false,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startMs,
        error: String(error),
      })
    );
    process.exitCode = 1;
  } finally {
    await context.close();
  }
}

main();
