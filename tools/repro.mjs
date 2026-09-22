/**
 * Drive the real page in headless Chromium and find where it dies.
 *
 * Every 500 ms it asks the page to evaluate `1+1` with a 4 s timeout. If the
 * main thread is blocked, that call cannot return, which is exactly the
 * symptom — a frozen tab — measured rather than guessed at.
 *
 *   node tools/repro.mjs "some question"
 */
import { chromium } from "playwright";

const GOAL = process.argv[2] || "Playwright vs Cypress vs Selenium compared";
const APP = "http://localhost:8790";

const b = await chromium.launch({ args: ["--no-sandbox"] });
const page = await b.newPage({ viewport: { width: 1500, height: 950 } });

const errors = [];
page.on("console", m => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
page.on("pageerror", e => errors.push("PAGEERROR " + e.message.slice(0, 200)));
page.on("crash", () => errors.push("TAB CRASHED"));

await page.goto(APP, { waitUntil: "domcontentloaded" });

// long-task observer: anything over 100 ms is a jank source
await page.evaluate(() => {
  window.__long = [];
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) window.__long.push(Math.round(e.duration));
  }).observe({ entryTypes: ["longtask"] });
});

await page.fill("#prompt", GOAL);
await page.evaluate(() => {
  document.getElementById("depth").value = 3;
  document.getElementById("depth").dispatchEvent(new Event("input"));
  document.getElementById("minsrc").value = 20;
  document.getElementById("minsrc").dispatchEvent(new Event("input"));
});
await page.click("#run");
console.log("run started:", GOAL);

const t0 = Date.now();
let frozenAt = null;
for (let i = 0; i < 700; i++) {
  const el = ((Date.now() - t0) / 1000).toFixed(0).padStart(4);
  let phase = "?", nodes = 0, pulses = 0, secs = 0, chars = 0, heap = 0, long = 0;
  try {
    const snap = await page.evaluate(() => ({
      phase: document.getElementById("phase")?.textContent || "",
      nodes: document.querySelectorAll(".node").length,
      pulses: document.querySelectorAll(".wire.pulse").length,
      secs: document.querySelectorAll(".sec:not([hidden])").length,
      chars: document.getElementById("report")?.textContent.length || 0,
      heap: Math.round((performance.memory?.usedJSHeapSize || 0) / 1e6),
      long: window.__long.length,
      worst: Math.max(0, ...window.__long.slice(-40)),
      done: /Run complete|gone|failed|refused/i.test(document.getElementById("phase")?.textContent || ""),
    }), { timeout: 4000 });
    ({ phase, nodes, pulses, secs, chars, heap, long } = snap);
    console.log(`${el}s  ${phase.slice(0, 34).padEnd(34)} nodes=${String(nodes).padStart(3)} pulse=${String(pulses).padStart(3)} secs=${secs} chars=${String(chars).padStart(6)} heap=${heap}MB longtasks=${long} worst=${snap.worst}ms`);
    if (snap.done) { console.log("finished cleanly"); break; }
  } catch (e) {
    frozenAt = { at: el, err: e.message.split("\n")[0].slice(0, 90) };
    console.log(`${el}s  >>> MAIN THREAD BLOCKED — ${frozenAt.err}`);
    break;
  }
  await new Promise(r => setTimeout(r, 500));
}

if (errors.length) { console.log("\nconsole errors:"); errors.slice(0, 10).forEach(e => console.log("  " + e)); }
if (frozenAt) console.log("\nFROZE at", frozenAt.at + "s");
await b.close();
