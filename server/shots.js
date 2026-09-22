/**
 * Page thumbnails.
 *
 * One headless Chromium for the whole process, a small pool of pages, and a
 * hard timeout per shot. A screenshot is never allowed to hold up a crawl:
 * capture runs alongside the fetch-and-judge pass and the card swaps its text
 * preview for the image whenever the image happens to land.
 *
 * Failures are normal and silent — plenty of sites refuse a headless browser,
 * and a missing thumbnail costs nothing because the card already shows the
 * page's opening lines.
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cfg, ROOT } from "./config.js";

const SHOT_DIR = join(ROOT, "data", "shots");
const WIDTH = 1000, HEIGHT = 593;       // the page is LAID OUT at this size…
/* …but rasterised at a third of it. A card shows the thumbnail at 162x96 css
   px, and a decoded bitmap costs 4 bytes per pixel at its NATURAL size — so a
   full-resolution capture cost ~2.8 MB of image memory per card and took the
   tab down at around a hundred cards. None of that shows up in
   usedJSHeapSize, which is why it looked like a JS problem and was not. */
const SCALE = 0.324;                    // -> 324x192: exactly the card's 162x96 at 2x, not a pixel more
const QUALITY = 0.58;                   // webp; ~5 KB a card
const TIMEOUT_MS = 12_000;
const MAX_PARALLEL = 3;

let browser = null;
let starting = null;
let active = 0;
/* Two queues. A renderPage() is on the crawl's critical path — a worker is
   waiting on it — so it goes ahead of every thumbnail, which nothing waits
   for. Without this a burst of kept pages queued their screenshots in front
   of the one fetch that actually needed the browser. */
const queue = { urgent: [], idle: [] };

async function getBrowser() {
  if (browser) return browser;
  if (!starting) {
    starting = chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars", "--mute-audio"],
    }).then(b => {
      browser = b;
      b.on("disconnected", () => { browser = null; starting = null; });
      return b;
    }).catch(e => { starting = null; throw e; });
  }
  return starting;
}

export async function closeBrowser() {
  const b = browser; browser = null; starting = null;
  await b?.close().catch(() => {});
}

function slot(urgent = false) {
  if (active < MAX_PARALLEL) { active++; return Promise.resolve(); }
  return new Promise(r => (urgent ? queue.urgent : queue.idle).push(r));
}
function release() {
  active--;
  const next = queue.urgent.shift() || queue.idle.shift();
  if (next) { active++; next(); }
}

/**
 * Capture `url` and write it under data/shots/<runId>/<nodeId>.jpg.
 * Resolves to the public path, or null if the page would not be photographed.
 */
/**
 * Read a page with the real browser.
 *
 * The plain fetcher loses to three things: client-rendered pages with no text
 * in the HTML, 403s aimed at non-browser clients, and Reddit, which does both.
 * This costs a browser context, so it runs only after readPage() has failed.
 */
export async function renderPage(url, { signal } = {}) {
  if (signal?.aborted) return { error: "aborted" };
  await slot(true);
  let ctx = null;
  // an abort closes the context, which makes goto() throw and frees the slot
  const onAbort = () => ctx?.close().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) return { error: "aborted" };
    const b = await getBrowser();
    ctx = await b.newContext({
      viewport: { width: 1280, height: 1000 },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
                 "(KHTML, like Gecko) Chrome/125.0 Safari/537.36",
    });
    const page = await ctx.newPage();
    await page.route("**/*", r => {
      const t = r.request().resourceType();
      if (t === "image" || t === "media" || t === "font") return r.abort();
      r.continue();
    });
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForTimeout(1800);

    const out = await page.evaluate(() => {
      for (const el of document.querySelectorAll("script,style,noscript,svg,nav,header,footer,aside"))
        el.remove();
      const text = (document.body?.innerText || "")
        .replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      const seen = new Map();
      for (const a of document.querySelectorAll("a[href]")) {
        const t = (a.innerText || "").replace(/\s+/g, " ").trim();
        if (t.length < 4 || t.length > 120) continue;
        try {
          const u = new URL(a.href, location.href);
          if (!/^https?:$/.test(u.protocol)) continue;
          u.hash = "";
          if (!seen.has(u.toString()))
            seen.set(u.toString(), { url: u.toString(), text: t, host: u.hostname.replace(/^www\./, "") });
        } catch {}
        if (seen.size >= 300) break;
      }
      return { title: document.title || "", text, links: [...seen.values()] };
    });

    if (!out.text || out.text.length < 200) return { error: "rendered but still has no text" };
    return {
      url: page.url(),
      host: new URL(page.url()).hostname.replace(/^www\./, ""),
      title: (out.title || new URL(page.url()).hostname).slice(0, 180),
      text: out.text.slice(0, cfg.pageChars),
      chars: out.text.length,
      links: out.links,
      rendered: true,
      status: res?.status?.() ?? null,
    };
  } catch (e) {
    return { error: e.message.split("\n")[0].slice(0, 120) };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await ctx?.close().catch(() => {});
    release();
  }
}

export async function capture(url, runId, nodeId, { signal } = {}) {
  if (signal?.aborted) return null;
  await slot();
  let ctx = null;
  try {
    const b = await getBrowser();
    ctx = await b.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: SCALE,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
                 "(KHTML, like Gecko) Chrome/125.0 Safari/537.36",
      javaScriptEnabled: true,
    });
    const page = await ctx.newPage();
    // Media and fonts are most of the bytes and none of the look at this size.
    await page.route("**/*", route => {
      const t = route.request().resourceType();
      if (t === "media" || t === "font") return route.abort();
      route.continue();
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
    await page.waitForTimeout(900);              // let above-the-fold settle
    // Cookie walls sit over everything and make every thumbnail look identical.
    await page.evaluate(() => {
      const kill = /cookie|consent|gdpr|onetrust|banner|overlay|modal|paywall/i;
      for (const el of document.querySelectorAll("div,section,aside,dialog")) {
        const s = getComputedStyle(el);
        if ((s.position === "fixed" || s.position === "sticky") &&
            (kill.test(el.className || "") || kill.test(el.id || "") || el.tagName === "DIALOG")) {
          el.remove();
        }
      }
    }).catch(() => {});

    const buf = await page.screenshot({ type: "png" });
    const dir = join(SHOT_DIR, runId);
    await mkdir(dir, { recursive: true });
    /* Re-encode as WebP on a blank page (the target page may have a CSP that
       forbids data: images). Smaller to fetch and, more to the point, cheaper
       for the board to decode a hundred of. */
    try {
      const blank = await ctx.newPage();
      const url = await blank.evaluate(async ({ b64, q }) => {
        const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
        const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return c.toDataURL("image/webp", q);
      }, { b64: buf.toString("base64"), q: QUALITY });
      await blank.close().catch(() => {});
      if (url.startsWith("data:image/webp")) {
        await writeFile(join(dir, `${nodeId}.webp`), Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
        return `/shots/${runId}/${nodeId}.webp`;
      }
    } catch { /* fall through to jpeg */ }
    await writeFile(join(dir, `${nodeId}.jpg`), await page.screenshot({ type: "jpeg", quality: 70 }));
    return `/shots/${runId}/${nodeId}.jpg`;
  } catch {
    return null;
  } finally {
    await ctx?.close().catch(() => {});
    release();
  }
}
