/**
 * Settings, read once from .env.
 *
 * Nothing here is secret to the client: the browser never sees a key, because
 * every outbound call is made from this process.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Minimal .env reader — no dependency, and it leaves real env vars winning.
try {
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch { /* running with real env vars only */ }

export const cfg = {
  port: Number(process.env.PORT || 8790),

  jevKey: process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY || "",
  jevModel: process.env.JEV_MODEL || "jev-1.13.0",
  jevUrl: process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai",

  llmKey: process.env.OPENROUTER_API_KEY || "",
  llmModel: process.env.LLM_MODEL || "qwen/qwen3.6-plus",

  searxUrl: process.env.SEARXNG_URL || "http://127.0.0.1:8888/search",
  searxKey: process.env.SEARXNG_KEY || "",
  /* SearXNG's default engine set is a handful of the most-scraped engines, and
     they are the first to CAPTCHA or rate-suspend — a node down to zero of them
     still answers 200 with an empty results array. Naming a wider set routes
     around whichever are currently blocked. */
  searxEngines: process.env.SEARXNG_ENGINES ||
    "bing,google,mojeek,yep,seznam,naver,wikipedia,marginalia,stract,crowdview,brave,duckduckgo,qwant,startpage",

  // Crawl budget. Depth can run to 50; these stop a deep run from running away.
  maxPages: Number(process.env.MAX_PAGES || 120),
  perPageLinks: Number(process.env.PER_PAGE_LINKS || 3),   // children Jev may pick per page
  concurrency: Number(process.env.CONCURRENCY || 18),   // fetch+judge in flight at once
  pageChars: Number(process.env.PAGE_CHARS || 14000),      // text kept per page; the report reads it in full
  maxSources: Number(process.env.MAX_SOURCES || 40),       // sources handed to the report
  threshold: Number(process.env.THRESHOLD || 0.62),        // relevance at or above this is kept
  // A search hit whose title+snippet score below this is never fetched. Low on
  // purpose: it only needs to catch the results that are obviously not it.
  triageFloor: Number(process.env.TRIAGE_FLOOR || 0.15),

  // "Enough content" is a source count the run tries to reach. While it is
  // short of it and the queue is running thin, the crawl asks for new queries
  // shaped by which of the previous ones produced keepers, and searches them
  // alongside the reading. maxWaves caps how many batches of queries a run
  // may issue in total, the planned one included.
  minSources: Number(process.env.MIN_SOURCES || 10),
  maxWaves: Number(process.env.MAX_WAVES || 6),
};

export function missing() {
  const out = [];
  if (!cfg.jevKey) out.push("TYPESAFE_API_KEY");
  if (!cfg.llmKey) out.push("OPENROUTER_API_KEY");
  return out;
}
