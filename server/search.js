/**
 * Web search through the SearXNG node OnePersonCompany already runs.
 *
 * Ported from onepersoncompany/server/src/providers/searxng.ts. Two things
 * carried over verbatim because they were learned the hard way there:
 *
 *   - the key goes in an `x-api-key` HEADER, never the query string, so it
 *     never lands in an access log or a referrer;
 *   - `unresponsive_engines` is kept and surfaced. A metasearch node down to
 *     one engine still returns ten links and still looks like it is working,
 *     which is the failure you otherwise cannot see.
 *
 * On the Pi the node is managed and bound to loopback, so a key is not used
 * and this machine reaches it over the SSH tunnel (`npm run tunnel`).
 */
import { cfg } from "./config.js";

const UA = "sounding-line/0.1";

export async function search(query, { limit = 10, signal } = {}) {
  const url = new URL(cfg.searxUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("safesearch", "0");
  if (cfg.searxEngines) url.searchParams.set("engines", cfg.searxEngines);

  const headers = { "user-agent": UA, accept: "application/json" };
  if (cfg.searxKey) headers["x-api-key"] = cfg.searxKey;

  let res;
  try {
    res = await fetch(url, { headers, signal, redirect: "follow" });
  } catch (e) {
    throw new Error(
      `search node unreachable at ${cfg.searxUrl} (${e.message}). ` +
      `Start the tunnel: npm run tunnel`);
  }
  if (!res.ok) throw new Error(`search node returned ${res.status}`);

  const body = await res.json();
  if (!Array.isArray(body.results)) throw new Error("search node sent no results array");

  const results = [];
  for (const row of body.results) {
    if (!row || typeof row !== "object") continue;
    const u = typeof row.url === "string" ? row.url : "";
    const title = typeof row.title === "string" ? row.title : "";
    if (!u || !title) continue;
    results.push({
      url: u,
      title,
      snippet: typeof row.content === "string" ? row.content.slice(0, 400) : "",
      engines: Array.isArray(row.engines) ? row.engines : [],
    });
    if (results.length >= limit) break;
  }

  const unresponsive = Array.isArray(body.unresponsive_engines)
    ? body.unresponsive_engines
        .filter(p => Array.isArray(p) && typeof p[0] === "string")
        .map(p => ({ engine: p[0], reason: typeof p[1] === "string" ? p[1] : "no reason given" }))
    : [];

  const answered = new Set();
  for (const r of results) for (const e of r.engines) answered.add(e);
  return { results, unresponsive, answered: [...answered] };
}
