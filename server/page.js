/**
 * Fetch one page and turn it into the two things the crawl needs: readable
 * text, and the outbound links Jev will choose its next hop from.
 *
 * Follows onepersoncompany/server/src/integrations/growth/pages.ts in the
 * parts that matter — a hop cap, an http(s)-only scheme check, a size cap, and
 * a failure that returns a reason rather than throwing, so one dead page never
 * takes a crawl down.
 *
 * No parser dependency: a regex strip is enough to judge relevance and to cite
 * from, and it cannot be made to execute anything.
 */
import { cfg } from "./config.js";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/125.0 Safari/537.36 sounding-line/0.1";
const MAX_HOPS = 4;
const MAX_BYTES = 2_500_000;
const TIMEOUT_MS = 15_000;

/** Nav furniture and anything that is never a research source. */
/* Reddit is deliberately NOT here: threads are often the only place a real
   account of a problem exists. It needs the browser to read, which the
   render fallback handles. */
const LINK_DENY = /(^|\.)((facebook|twitter|x|instagram|linkedin|youtube|tiktok|pinterest)\.com|t\.co|bit\.ly)$/i;
const PATH_DENY = /\/(login|signin|signup|register|cart|checkout|privacy|terms|cookie|legal|careers|jobs|contact|rss|feed)(\/|$|\?)/i;
const EXT_DENY  = /\.(zip|dmg|exe|pkg|tar|gz|mp4|mp3|avi|mov|png|jpe?g|gif|svg|webp|ico|css|js)(\?|$)/i;

function decode(s) {
  return s
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
}

function stripToText(html) {
  return decode(html
    .replace(/\r\n?/g, "\n")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[^\S\n]+/g, " ")        // spaces, tabs, nbsp — but keep newlines
    .replace(/^[^\S\n]+|[^\S\n]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")   // a stripped nav leaves dozens of blank lines
    .trim();
}

function links(html, baseUrl) {
  const out = new Map();
  const re = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.size < 300) {
    let href = m[1].trim();
    if (!href || href.startsWith("#") || /^(javascript|mailto|tel):/i.test(href)) continue;
    let u;
    try { u = new URL(href, baseUrl); } catch { continue; }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    u.hash = "";
    const key = u.toString();
    if (out.has(key)) continue;
    if (LINK_DENY.test(u.hostname) || PATH_DENY.test(u.pathname) || EXT_DENY.test(u.pathname)) continue;

    const text = stripToText(m[2]).replace(/\s+/g, " ").trim();
    if (text.length < 4 || text.length > 120) continue;   // icons and paragraphs, not links
    out.set(key, { url: key, text, host: u.hostname.replace(/^www\./, "") });
  }
  return [...out.values()];
}

export async function readPage(url, { signal } = {}) {
  let u;
  try { u = new URL(String(url)); } catch { return { error: `not a URL: ${String(url).slice(0, 120)}` }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { error: `${u.protocol} is not a scheme this fetches` };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    let current = u.toString(), res;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      res = await fetch(current, {
        redirect: "manual",
        signal: ctrl.signal,
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        current = new URL(res.headers.get("location"), current).toString();
        continue;
      }
      break;
    }
    if (!res.ok) return { error: `HTTP ${res.status}` };

    const type = res.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml|text\/plain/i.test(type)) return { error: `not a page (${type.split(";")[0] || "unknown type"})` };

    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > MAX_BYTES) return { error: `page is ${(declared / 1e6).toFixed(1)} MB` };
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return { error: `page is ${(buf.byteLength / 1e6).toFixed(1)} MB` };
    const html = new TextDecoder("utf-8", { fatal: false }).decode(buf);

    const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "").trim()).slice(0, 180)
      || new URL(current).hostname;
    const text = stripToText(html);
    if (text.length < 200) return { error: "page has almost no text (client-rendered?)" };

    return {
      url: current,
      host: new URL(current).hostname.replace(/^www\./, ""),
      title,
      text: text.slice(0, cfg.pageChars),
      chars: text.length,
      links: links(html, current),
    };
  } catch (e) {
    return { error: e.name === "AbortError" ? "timed out" : e.message };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
