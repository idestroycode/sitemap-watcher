// Sitemap watcher for GitHub Actions. Node 20+, no dependencies.
// Checks sitemaps, emails you (via Resend) when a matching URL is new or has a
// newer lastmod, and writes RSS files into /docs (published with GitHub Pages).

import { readFile, writeFile, mkdir } from "node:fs/promises";

/* ------------------------------------------------------------------ *
 * CONFIG
 *   urls:     one or more sitemap URLs (combined into a single feed)
 *   mode:     "include" = only track URLs matching at least one pattern
 *             "exclude" = track every URL EXCEPT those matching any pattern
 *   patterns: regular expressions (case-insensitive) tested against the
 *             full URL, so "gaming" also matches "igaming".
 *             In a JS string, escape backslashes: "agco\\.ca/fr"
 * ------------------------------------------------------------------ */

// Keywords for every canada.ca sitemap (regular expressions, matched against the URL)
const CANADA_KEYWORDS = [
  "drug",
  "controlled[-_ ]?substance", // matches controlled-substance(s), controlled_substances, ...
  "cdsa",
  "cannabis",
  "vaping",
  "tobacco",
  "liquor",
  "alcohol",
  "excise",
  "nicotine",
];

const FEEDS = [
  {
    id: "health-canada",
    name: "Health Canada",
    urls: ["https://www.canada.ca/en/health-canada.sitemap.xml"],
    mode: "include",
    patterns: CANADA_KEYWORDS,
  },
  {
    id: "cra",
    name: "CRA",
    urls: ["https://www.canada.ca/en/revenue-agency.sitemap.xml"],
    mode: "include",
    patterns: CANADA_KEYWORDS,
  },
  {
    // canada.ca publishes one sitemap per section. Pages whose address starts
    // /en/services/... (e.g. /en/services/health/publications/...) are only listed here.
    id: "canada-services",
    name: "Canada.ca services pages",
    urls: ["https://www.canada.ca/en/services.sitemap.xml"],
    mode: "include",
    patterns: CANADA_KEYWORDS,
  },
  {
    id: "canada-news",
    name: "Canada.ca news",
    urls: ["https://www.canada.ca/en/news.sitemap.xml"],
    mode: "include",
    patterns: CANADA_KEYWORDS,
  },
  {
    id: "public-health",
    name: "Public Health Agency of Canada",
    urls: ["https://www.canada.ca/en/public-health.sitemap.xml"],
    mode: "include",
    patterns: CANADA_KEYWORDS,
  },
  {
    id: "department-finance",
    name: "Finance Canada",
    urls: ["https://www.canada.ca/en/department-finance.sitemap.xml"],
    mode: "include",
    patterns: CANADA_KEYWORDS,
  },
  {
    id: "agco",
    name: "AGCO",
    urls: [
      "https://www.agco.ca/sitemap.xml?page=1",
      "https://www.agco.ca/sitemap.xml?page=2",
      "https://www.agco.ca/sitemap.xml?page=3",
    ],
    mode: "exclude",
    patterns: ["/fr/", "agco\\.ca/fr([/?#]|$)", "horse", "gaming", "lottery"],
  },
];

const TIMEZONE = "America/Toronto"; // plain-language dates in emails and RSS
// true  = also alert when a URL appears for the first time (never seen before).
// false = alert ONLY when an already-known URL gets a newer lastmod.
const ALERT_ON_NEW_URLS = true;

// A known URL only counts as "updated" if its lastmod moved forward by MORE than
// this many seconds. canada.ca's sitemap reports slightly different timestamps for
// the same page from one fetch to the next (seconds, and sometimes a few minutes),
// so tiny differences are ignored. Real edits move the date by hours or days.
const MIN_CHANGE_SECONDS = 600; // 10 minutes

const TITLE_FETCH_LIMIT = 300;       // max pages to open per run to read their real titles
const MAX_ITEMS = 300;              // entries kept in the RSS feeds
const MAX_CHILD_SITEMAPS = 50;      // cap if a feed is a sitemap index
const UA = "SitemapWatcher/1.0 (+GitHub Actions)";
const PAGE_UA = "Mozilla/5.0 (compatible; SitemapWatcher/1.0)"; // used when opening pages to read titles

/* ------------------------------------------------------------------ */

const STATE_FILE = "data/state.json";
const SITE_URL = (process.env.SITE_URL || "").replace(/\/+$/, "");
const EMAIL_FROM = process.env.EMAIL_FROM;
const EMAIL_TO = process.env.EMAIL_TO;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function main() {
  const state = await loadState();
  const status = { feeds: {} };
  const newItems = [];
  const nextFeedState = {};
  const nextSigs = {};

  for (const feed of FEEDS) {
    try {
      const prev = state.feeds[feed.id];
      // If a feed's URLs, mode or keywords changed since the last run, URLs that match
      // for the first time are recorded silently instead of being announced as "new".
      const sigChanged = !!prev && state.sigs[feed.id] !== feedSignature(feed);
      const r = await checkFeed(feed, prev, { silentNew: sigChanged });
      nextFeedState[feed.id] = r.next;
      nextSigs[feed.id] = feedSignature(feed);
      newItems.push(...r.items);
      status.feeds[feed.id] = {
        ok: true,
        baseline: r.baseline,
        urlsInSitemap: r.total,
        urlsMatchingFilter: r.matched,
        newOrUpdated: r.items.length,
      };
      console.log(`${feed.id}: ${r.baseline ? "baseline saved" : r.items.length + " new/updated"}${sigChanged ? " [settings changed: new matches recorded silently]" : ""} (${r.matched} of ${r.total} URLs match filter)`);
    } catch (err) {
      // A failed feed keeps its old state, so nothing is lost or falsely reported
      console.log(`::warning title=Feed failed::${feed.id}: ${err.message}`);
      status.feeds[feed.id] = { ok: false, error: String(err.message || err) };
    }
  }

  // If the email fails this throws, nothing is saved, and the next run retries.
  if (newItems.length) {
    await addFullTitles(newItems); // replaces slug-based titles with the real page titles
    await sendEmail(newItems);
  }

  for (const [id, next] of Object.entries(nextFeedState)) state.feeds[id] = next;
  for (const [id, sig] of Object.entries(nextSigs)) state.sigs[id] = sig;
  state.items = [...newItems, ...state.items].slice(0, MAX_ITEMS);

  await writeOutputs(state, status);
}

/* ------------------------------ core ------------------------------ */

async function checkFeed(feed, prev, opts = {}) {
  const stats = { total: 0 };
  const keep = (loc) => passes(feed, loc);
  // If any one sitemap fails, the whole feed is skipped this run.
  const filtered = (await Promise.all(feed.urls.map((u) => fetchSitemap(u, keep, stats)))).flat();

  // A URL listed more than once keeps its latest lastmod
  const cur = new Map();
  for (const e of filtered) cur.set(e.loc, later(cur.get(e.loc), e.lastmod));
  const counts = { total: stats.total, matched: cur.size };

  // First run: record the current state without flooding you with every URL
  if (!prev) return { items: [], next: sortedObject(cur), baseline: true, ...counts };

  const detectedAt = new Date().toISOString();
  const mk = (kind, loc, lastmod, previous) => ({
    id: `${loc}#${lastmod}`,
    feedId: feed.id,
    feedName: feed.name,
    title: titleFromUrl(loc),
    link: loc,
    lastmod,
    kind,
    previous,
    detectedAt,
  });

  const items = [];
  // Start from what we already knew: URLs that vanish stay remembered, so a
  // URL that drops out of the sitemap and comes back is not treated as new.
  const merged = new Map(Object.entries(prev));

  for (const [loc, lastmod] of cur) {
    const old = prev[loc];

    if (old === undefined) {
      if (ALERT_ON_NEW_URLS && lastmod && !opts.silentNew) items.push(mk("New URL", loc, lastmod, ""));
      merged.set(loc, lastmod);
      continue;
    }

    if (isNewer(lastmod, old, MIN_CHANGE_SECONDS)) items.push(mk("Updated", loc, lastmod, old));
    // Never move a stored date backwards (protects against stale copies of the sitemap)
    merged.set(loc, later(old, lastmod));
  }

  return { items, next: sortedObject(merged), baseline: false, ...counts };
}

// true only if `a` is a valid date later than `b` by more than `minSeconds`
function isNewer(a, b, minSeconds = 0) {
  const ta = Date.parse(a);
  if (!a || isNaN(ta)) return false;
  if (!b) return true; // known URL that previously had no lastmod
  const tb = Date.parse(b);
  return isNaN(tb) ? true : ta - tb > minSeconds * 1000;
}

// whichever of the two dates is later (empty/missing values lose)
function later(a, b) {
  if (!a) return b || "";
  if (!b) return a;
  return isNewer(b, a) ? b : a;
}

function sortedObject(map) {
  const out = {};
  for (const k of [...map.keys()].sort()) out[k] = map.get(k);
  return out;
}

function feedSignature(feed) {
  return JSON.stringify([feed.urls, feed.mode, feed.patterns]);
}

const REGEX_CACHE = new Map();

function regexesFor(feed) {
  if (!REGEX_CACHE.has(feed.id)) {
    REGEX_CACHE.set(feed.id, feed.patterns.map((p) => new RegExp(p, "i")));
  }
  return REGEX_CACHE.get(feed.id);
}

function passes(feed, loc) {
  const hit = regexesFor(feed).some((rx) => rx.test(loc));
  return feed.mode === "include" ? hit : !hit;
}

/* ------------------------- full page titles ----------------------- */

// Opens each changed page and reads its real title. Falls back to the
// URL-based title if a page can't be fetched or has no title.
async function addFullTitles(items) {
  const todo = items.slice(0, TITLE_FETCH_LIMIT);
  let next = 0;
  let failed = 0;
  const reasons = [];
  const worker = async () => {
    while (next < todo.length) {
      const item = todo[next++];
      try {
        const t = await fetchPageTitle(item.link);
        if (t) item.title = t;
        else {
          failed++;
          if (reasons.length < 5) reasons.push(`${item.link}: no title found in page`);
        }
      } catch (err) {
        failed++;
        if (reasons.length < 5) reasons.push(`${item.link}: ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  console.log(`Page titles: ${todo.length - failed} read, ${failed} fell back to URL-based title`);
  for (const r of reasons) console.log(`  title not read -> ${r}`);
}

async function fetchPageTitle(url) {
  const res = await fetch(url, {
    headers: { "user-agent": PAGE_UA, accept: "text/html,application/xhtml+xml,*/*" },
    signal: AbortSignal.timeout(30000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = (await res.text()).slice(0, 500000); // title and h1 are near the top
  return extractTitle(html);
}

// Prefers <title> (minus a trailing site name such as "- Canada.ca"), falls back to <h1>.
function extractTitle(html) {
  let t = "";
  const tt = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (tt) {
    t = htmlToText(tt[1]).replace(
      /\s*[-|–—]\s*(Canada\.ca|AGCO|Alcohol and Gaming Commission of Ontario|Government of Canada|ontario\.ca)\s*$/i,
      ""
    );
  }
  if (!t) {
    const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
    if (h1) t = htmlToText(h1[1]);
  }
  return t;
}

function htmlToText(s) {
  return decodeHtml(s.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

function decodeHtml(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/* ----------------------------- sitemap ---------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": UA, accept: "application/xml,text/xml,*/*" },
        signal: AbortSignal.timeout(90000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await sleep(attempt * 3000);
    }
  }
  throw lastErr;
}

async function fetchSitemap(url, keep, stats) {
  const xml = await fetchText(url);

  if (/<sitemapindex\b/i.test(xml)) {
    const children = parseBlocks(xml, "sitemap").slice(0, MAX_CHILD_SITEMAPS);
    const all = [];
    for (const c of children) {
      const childXml = await fetchText(c.loc); // errors propagate on purpose
      all.push(...parseBlocks(childXml, "url", keep, stats));
    }
    return all;
  }
  return parseBlocks(xml, "url", keep, stats);
}

const RE_URL = /<url\b[^>]*>([\s\S]*?)<\/url>/gi;
const RE_SITEMAP = /<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi;
const RE_LOC = /<loc\b[^>]*>([\s\S]*?)<\/loc>/i;
const RE_LASTMOD = /<lastmod\b[^>]*>([\s\S]*?)<\/lastmod>/i;

function parseBlocks(xml, tagName, keep, stats) {
  const out = [];
  const re = new RegExp(tagName === "sitemap" ? RE_SITEMAP : RE_URL);
  let m;
  while ((m = re.exec(xml))) {
    const lm = RE_LOC.exec(m[1]);
    if (!lm) continue;
    const loc = cleanText(lm[1]);
    if (!loc) continue;
    if (stats) stats.total++;
    if (keep && !keep(loc)) continue;
    const mm = RE_LASTMOD.exec(m[1]);
    out.push({ loc, lastmod: mm ? cleanText(mm[1]) : "" });
  }
  return out;
}

function cleanText(s) {
  return decodeXml(s.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, "").trim());
}

function decodeXml(s) {
  if (!s.includes("&")) return s;
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function titleFromUrl(u) {
  try {
    const parts = new URL(u).pathname
      .split("/")
      .filter(Boolean)
      .map((seg) => decodeURIComponent(seg).replace(/\.[a-z0-9]+$/i, ""));
    let slug = parts[parts.length - 1] || new URL(u).hostname;
    // A one-word last segment ("bulletin", "notice", "guide") says little on its own,
    // so include the folder above it: ".../natural-health-product-licensing/bulletin.html"
    if (!/[-_ ]/.test(slug) && parts.length > 1) slug = parts[parts.length - 2] + " " + slug;
    return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  } catch {
    return u;
  }
}

// "2026-10-06T19:45:00Z" -> "Tuesday, October 6, 2026 at 3:45 PM EDT"
// Date-only values have no time, so only the date is shown.
function formatLastmod(raw) {
  if (!raw) return "unknown";
  try {
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      const d = new Date(raw + "T12:00:00Z");
      return (
        new Intl.DateTimeFormat("en-US", {
          weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
        }).format(d) + " (no time given)"
      );
    }
    const t = Date.parse(raw);
    if (isNaN(t)) return raw;
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
      hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: TIMEZONE,
    }).format(new Date(t));
  } catch {
    return raw;
  }
}

/* ------------------------------ state ----------------------------- */

async function loadState() {
  try {
    const s = JSON.parse(await readFile(STATE_FILE, "utf8"));
    return { feeds: s.feeds || {}, items: s.items || [], sigs: s.sigs || {} };
  } catch {
    return { feeds: {}, items: [], sigs: {} };
  }
}

// One URL per line so git diffs stay small
function serializeState(state) {
  const feeds = Object.entries(state.feeds)
    .map(
      ([id, urls]) =>
        `  ${JSON.stringify(id)}: {\n` +
        Object.entries(urls).map(([u, l]) => `    ${JSON.stringify(u)}: ${JSON.stringify(l)}`).join(",\n") +
        `\n  }`
    )
    .join(",\n");
  return `{\n"feeds": {\n${feeds}\n},\n"sigs": ${JSON.stringify(state.sigs || {}, null, 1)},\n"items": ${JSON.stringify(state.items, null, 1)}\n}\n`;
}

async function writeOutputs(state, status) {
  await mkdir("data", { recursive: true });
  await mkdir("docs/rss", { recursive: true });

  await writeFile(STATE_FILE, serializeState(state));
  await writeFile("docs/rss.xml", buildRss("Sitemap changes", `${SITE_URL}/rss.xml`, state.items));
  for (const f of FEEDS) {
    await writeFile(
      `docs/rss/${f.id}.xml`,
      buildRss(`${f.name} changes`, `${SITE_URL}/rss/${f.id}.xml`, state.items.filter((i) => i.feedId === f.id))
    );
  }
  await writeFile("docs/status.json", JSON.stringify(status, null, 2) + "\n");
  await writeFile("docs/index.html", indexHtml());
  // Monthly heartbeat so GitHub sees repository activity (see README notes)
  await writeFile("data/heartbeat.txt", new Date().toISOString().slice(0, 7) + "\n");
}

/* ------------------------------- RSS ------------------------------ */

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toRfc822(d) {
  const t = Date.parse(d);
  return new Date(isNaN(t) ? 0 : t).toUTCString();
}

function buildRss(title, selfUrl, items) {
  const body = items
    .map(
      (i) => `    <item>
      <title>${esc(`[${i.feedName}] ${i.title}`)}</title>
      <link>${esc(i.link)}</link>
      <guid isPermaLink="false">${esc(i.id)}</guid>
      <pubDate>${toRfc822(i.lastmod)}</pubDate>
      <description>${esc(itemDescriptionHtml(i))}</description>
    </item>`
    )
    .join("\n");

  // Deterministic build date so the file only changes when entries change
  const built = items.length ? toRfc822(items[0].detectedAt || items[0].lastmod) : toRfc822("1970-01-01T00:00:00Z");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(title)}</title>
    <link>${esc(selfUrl)}</link>
    <description>Sitemap URLs whose lastmod has changed</description>
    <atom:link href="${esc(selfUrl)}" rel="self" type="application/rss+xml"/>
    <lastBuildDate>${built}</lastBuildDate>
${body}
  </channel>
</rss>
`;
}

// HTML for the RSS description: the clickable URL comes first so it is visible even in
// short previews; reader apps render this as a link.
function itemDescriptionHtml(i) {
  const when = `${i.kind}. Last modified: ${formatLastmod(i.lastmod)}${i.previous ? " (previously " + formatLastmod(i.previous) + ")" : ""}`;
  return `<p><a href="${esc(i.link)}">${esc(i.link)}</a></p><p>${esc(when)}</p>`;
}

function indexHtml() {
  const links = FEEDS.map((f) => `<li><a href="rss/${esc(f.id)}.xml">${esc(f.name)}</a></li>`).join("");
  return `<!doctype html><meta charset="utf-8"><title>Sitemap watcher</title>
<h1>Sitemap watcher</h1>
<ul><li><a href="rss.xml">All feeds combined</a></li>${links}<li><a href="status.json">Status</a></li></ul>
`;
}

/* ------------------------------ email ----------------------------- */

async function sendEmail(items) {
  if (!RESEND_API_KEY || !EMAIL_FROM || !EMAIL_TO) {
    throw new Error("Missing RESEND_API_KEY, EMAIL_FROM or EMAIL_TO secret");
  }

  const subject = `Sitemap changes: ${items.length} new/updated URL${items.length === 1 ? "" : "s"}`;

  const byFeed = {};
  for (const i of items) (byFeed[i.feedName] ||= []).push(i);

  const text = Object.entries(byFeed)
    .map(
      ([name, list]) =>
        `${name}\n` +
        list
          .map(
            (i) =>
              `  - ${i.kind}: ${i.title}\n    ${i.link}\n    Last modified: ${formatLastmod(i.lastmod)}` +
              (i.previous ? `\n    Previously: ${formatLastmod(i.previous)}` : "")
          )
          .join("\n")
    )
    .join("\n\n");

  const html = Object.entries(byFeed)
    .map(
      ([name, list]) =>
        `<h3>${esc(name)}</h3><ul>` +
        list
          .map(
            (i) =>
              `<li><strong>${esc(i.kind)}:</strong> <a href="${esc(i.link)}">${esc(i.title)}</a><br><small><a href="${esc(i.link)}">${esc(i.link)}</a><br>Last modified: ${esc(formatLastmod(i.lastmod))}${i.previous ? "<br>Previously: " + esc(formatLastmod(i.previous)) : ""}</small></li>`
          )
          .join("") +
        `</ul>`
    )
    .join("");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: `Sitemap Watcher <${EMAIL_FROM}>`, to: [EMAIL_TO], subject, text, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}
