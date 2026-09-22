/**
 * The run: plan, fan out, judge, descend — and widen WHILE that is happening.
 *
 * A crawl is one continuous pipeline, not a series of waves:
 *
 *   frontier   a priority queue of pages worth reading next. Search hits go in
 *              ordered by Jev's triage of their snippets; links go in ordered
 *              by (parent relevance × link confidence).
 *   workers    `concurrency` of them, each taking the best candidate, fetching
 *              it, asking Jev, and — if it was kept — asking Jev which of its
 *              links to queue. Nothing waits for a ring to finish.
 *   widener    watches the queue. When there is less queued than the workers
 *              can chew through, and the run is still short of `minSources`,
 *              it asks the LLM for new queries — told which of the previous
 *              ones actually produced keepers — and searches them, so fresh
 *              pages land before the workers go idle. It runs alongside the
 *              judging, never instead of it.
 *
 * The per-query yield table is the learning. Every Jev verdict updates it, and
 * every widening reads it, so each batch of queries is shaped by everything
 * judged so far — not by the batch before it.
 *
 * Depth controls how far a single lead is followed. Minimum sources controls
 * how hard the run tries. They are different questions, so they get different
 * dials.
 */
import { cfg } from "./config.js";
import { search } from "./search.js";
import { readPage } from "./page.js";
import { judge, pickLinks, triage } from "./jev.js";
import { plan, report, expand } from "./llm.js";
import { capture, renderPage } from "./shots.js";

const normalise = u => {
  try {
    const x = new URL(u);
    x.hash = ""; x.search = x.search.replace(/([?&])(utm_[^&]*|ref|fbclid|gclid)=[^&]*/g, "");
    return x.toString().replace(/\/$/, "");
  } catch { return u; }
};

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await worker(items[idx], idx); }
  }));
  return out;
}

/* The plain fetcher loses to bot protection and client-rendered pages. It
   does NOT lose to a 404, a PDF or a 3 MB download, and the browser costs a
   slot and up to 20 s, so it is only tried where it can actually win. */
const RENDERABLE = /^HTTP (401|403|429|5\d\d)$|almost no text/;

export async function runCrawl({ goal, depth, minSources, emit, signal, runId }) {
  const maxDepth = Math.max(1, Math.min(50, Number(depth) || 3));
  const want = Math.max(1, Math.min(50, Number(minSources) || cfg.minSources));

  const seen = new Set();
  const nodes = new Map();
  /* Reading has its own abort scope. Hitting the source target cuts it, so a
     straggler on a 20 s browser fallback cannot hold the report back; the
     run's own stop aborts it too. */
  const reading = new AbortController();
  const rs = reading.signal;
  signal.addEventListener("abort", () => reading.abort(), { once: true });
  let sealed = false;                      // target met: nothing read after this counts
  const inFlightNodes = new Set();
  const stats = {
    fetched: 0, kept: 0, cut: 0, failed: 0, triaged: 0, wave: 0, want, queued: 0, inFlight: 0,
    jevCalls: 0, jevMs: 0, jevTokens: 0, llmCalls: 0, llmCost: 0, jevCost: 0, cost: 0,
  };
  const JEV_PER_MTOK = 0.042;              // input tokens; output is free
  const recost = () => {
    stats.jevCost = (stats.jevTokens / 1e6) * JEV_PER_MTOK;
    stats.cost = +(stats.llmCost + stats.jevCost).toFixed(5);
  };
  const bump = () => { recost(); stats.queued = frontier.length; stats.inFlight = inFlight; emit("stats", stats); };
  const jev = r => { stats.jevCalls += r.calls ?? 1; stats.jevMs += r.ms; stats.jevTokens += r.tokens ?? 0; };

  let nextId = 0;
  const id = () => `n${++nextId}`;
  const add = node => { nodes.set(node.id, node); emit("node", node); return node; };
  const spend = usage => {
    stats.llmCalls += Number(usage?.calls || 1);   // the report is many calls, not one
    stats.llmCost += Number(usage?.cost || 0);
  };

  /* Which query produced which page, and what became of it. This is the only
     thing that makes a later batch of queries smarter than an earlier one, so
     it is updated on every verdict and read on every widening. */
  const queryYield = new Map();            // query -> { found, kept, cut, failed, triaged }
  const credit = (q, outcome) => {
    if (!q) return;
    const row = queryYield.get(q) || { found: 0, kept: 0, cut: 0, failed: 0, triaged: 0 };
    row.found++; row[outcome]++;
    queryYield.set(q, row);
  };
  const triedQueries = [];
  const health = { answered: new Set(), down: new Map() };

  // ------------------------------------------------------------ the queue
  const frontier = [];                     // sorted by prio, best first
  let inFlight = 0;
  let waiters = [];
  const notify = () => { const w = waiters; waiters = []; for (const r of w) r(); };
  const wait = () => new Promise(r => waiters.push(r));
  const enqueue = c => {
    let i = frontier.length;
    while (i > 0 && frontier[i - 1].prio < c.prio) i--;
    frontier.splice(i, 0, c);
  };
  const budgetLeft = () => cfg.maxPages - stats.fetched - inFlight;

  emit("phase", { text: "Planning queries", state: "live" });
  add({ id: "n0", parent: null, depth: 0, kind: "root", title: goal });

  const planned = await plan(goal, { signal });
  spend(planned.usage); bump();
  emit("plan", { queries: planned.queries, angle: planned.angle, wave: 1 });

  // ----------------------------------------------------------- searching
  /** Run queries, triage the hits with Jev, queue the survivors. Returns how many. */
  async function runSearches(queries) {
    const todo = queries.filter(q => !triedQueries.includes(q));
    todo.forEach(q => triedQueries.push(q));
    // The node answers several searches at once; doing them one after another
    // just added six round trips to the front of every batch.
    const batches = await pool(todo, 4, async q => {
      if (signal.aborted) return null;
      try { return { q, r: await search(q, { limit: 8, signal }) }; }
      catch (e) { emit("warn", { text: e.message }); return null; }
    });

    const hits = [];
    for (const b of batches) {
      if (!b) continue;
      for (const e of b.r.answered) health.answered.add(e);
      for (const u of b.r.unresponsive) health.down.set(u.engine, u.reason);
      for (const hit of b.r.results) {
        const u = normalise(hit.url);
        if (seen.has(u)) continue;
        seen.add(u);
        hits.push({ url: u, text: hit.title, snippet: hit.snippet, host: new URL(u).hostname.replace(/^www\./, ""), query: b.q, parent: "n0", depth: 1 });
      }
    }
    if (!hits.length || signal.aborted) return 0;

    /* A search result already says what it is. One Jev request scores every
       hit from its title and snippet, so the obviously-wrong ones are never
       fetched and the promising ones are read first. */
    let ranked = hits.map(h => ({ ...h, prio: 0.5 }));
    try {
      const t = await triage(hits, goal, { signal });
      jev(t);
      ranked = hits.map((h, i) => ({ ...h, prio: t.p[i] }));
    } catch (e) { emit("warn", { text: `triage failed, fetching everything: ${e.message}` }); }

    let queued = 0;
    for (const h of ranked) {
      if (h.prio < cfg.triageFloor) { stats.triaged++; credit(h.query, "triaged"); continue; }
      enqueue(h); queued++;
    }
    emit("log", { text: `${queued} of ${hits.length} new results worth reading` });
    bump(); notify();
    return queued;
  }

  const reportEngines = () => emit("engines", {
    unresponsive: [...health.down].map(([engine, reason]) => ({ engine, reason })),
    answered: [...health.answered],
  });

  // ------------------------------------------------------------ widening
  /* One widening at a time, each shaped by every verdict so far. It starts
     when the queue is thinner than the workers — so the new pages arrive
     before anyone is idle — or at a true dead end, whichever is first. */
  let expanding = null;
  let verdictsSinceWiden = 0;
  let dead = false;                        // the last widening found nothing new
  let keptAtWiden = 0, dudBatches = 0;     // batches in a row that added no keeper
  const LOW_WATER = cfg.concurrency;
  const MIN_EVIDENCE = 6;                  // fresh verdicts a widening should learn from

  function maybeWiden() {
    if (expanding || dead || signal.aborted) return;
    if (stats.kept >= want || budgetLeft() <= 0 || stats.wave >= cfg.maxWaves) return;
    const thin = frontier.length < LOW_WATER;
    const idle = frontier.length === 0 && inFlight === 0;
    if (!thin) return;
    if (verdictsSinceWiden < MIN_EVIDENCE && !idle) return;
    /* A batch that added nothing relevant is a sign the well is dry. Two in a
       row and the run stops asking, rather than spending every allowed batch
       on a target it is not going to reach. */
    if (stats.wave > 1) {
      dudBatches = stats.kept > keptAtWiden ? 0 : dudBatches + 1;
      if (dudBatches >= 2) { dead = true; emit("warn", { text: `two batches of new queries added nothing relevant — writing with ${stats.kept} of ${want}` }); return; }
    }
    keptAtWiden = stats.kept;

    const rows = [...queryYield].map(([query, v]) => ({ query, ...v }))
      .sort((a, b) => b.kept - a.kept || a.found - b.found);
    const keptNodes = [...nodes.values()].filter(n => n.kept);
    const hosts = [...new Set(keptNodes.map(n => n.host))].slice(0, 12);
    const titles = keptNodes.slice(-20).map(n => n.title);
    const pending = triedQueries.filter(q => !queryYield.has(q));   // searched, nothing judged yet

    verdictsSinceWiden = 0;
    stats.wave++;
    expanding = (async () => {
      const more = await expand(goal, { rows, pending, hosts, titles }, want - stats.kept, { signal });
      spend(more.usage);
      if (stats.kept >= want) return;      // the readers got there while the model was thinking
      const queries = more.queries.filter(q => !triedQueries.includes(q));
      if (!queries.length) { dead = true; emit("warn", { text: "no new angles left to try" }); return; }
      emit("plan", { queries, angle: more.why, wave: stats.wave });
      const n = await runSearches(queries);
      if (!n) { dead = true; emit("warn", { text: "new queries found no new pages" }); }
    })().catch(e => { dead = true; emit("warn", { text: `could not widen: ${e.message}` }); })
      .finally(() => { expanding = null; bump(); notify(); });
    status();
  }

  let lastStatus = "", statusTimer = null;
  const status = () => {
    if (statusTimer) return;                 // coalesced: the numbers change many times a second
    statusTimer = setTimeout(() => {
      statusTimer = null;
      const text = `Reading · ${inFlight} in flight · ${frontier.length} queued` +
        (expanding ? ` · widening (${stats.kept} of ${want})` : "");
      if (text === lastStatus) return;
      lastStatus = text;
      emit("phase", { text, state: "live" });
    }, 300);
  };

  // ------------------------------------------------------------ one page
  const shots = [];
  async function processNode(c) {
    const node = add({
      id: id(), parent: c.parent, depth: c.depth, kind: "page",
      url: c.url, host: c.host, title: c.text || c.host, state: "queued",
    });
    node.query = c.query;                  // carried down the branch, so credit reaches the seed query
    emit("node:state", { id: node.id, state: "fetching" });
    inFlightNodes.add(node.id);

    const drop = () => { if (!nodes.delete(node.id)) return; emit("node:drop", { id: node.id }); };
    let page = await readPage(node.url, { signal: rs });
    if (page.error && RENDERABLE.test(page.error) && !sealed) {
      const r = await renderPage(node.url, { signal: rs });
      if (!r.error) page = r;
    }
    inFlightNodes.delete(node.id);
    if (sealed) return drop();               // the report is already being written
    if (page.error) {
      stats.failed++; stats.fetched++; node.error = page.error; credit(node.query, "failed"); bump();
      emit("node:verdict", { id: node.id, kept: false, p: 0, error: page.error, signals: null });
      return;
    }
    node.title = page.title;

    let v;
    try { v = await judge(page, goal, { signal: rs }); }
    catch (e) {
      if (sealed) return drop();
      stats.failed++; stats.fetched++; node.error = e.message; credit(node.query, "failed"); bump();
      emit("node:verdict", { id: node.id, kept: false, p: 0, error: e.message, signals: null });
      return;
    }

    stats.fetched++; jev(v);
    v.kept ? stats.kept++ : stats.cut++;
    credit(node.query, v.kept ? "kept" : "cut");
    verdictsSinceWiden++;
    bump();

    node.kept = v.kept; node.p = v.p; node.signals = v.signals; node.text = page.text;
    node.excerpt = page.text.replace(/\n+/g, " · ").slice(0, 220);

    emit("node:verdict", {
      id: node.id, kept: v.kept, p: v.p, signals: v.signals,
      confidence: v.confidence, ms: v.ms, title: page.title, chars: page.chars,
      excerpt: node.excerpt,
    });
    if (!v.kept) return;

    // Only kept pages get a thumbnail. A discard already shows its opening
    // lines, which say more than a picture of a page you rejected — and it
    // keeps image memory proportional to what you actually read.
    shots.push(capture(page.url, runId, node.id, { signal })
      .then(src => { if (src) { node.shot = src; emit("node:shot", { id: node.id, src }); } })
      .catch(() => {}));

    if (c.depth >= maxDepth || stats.kept >= want || rs.aborted) return;
    let r;
    try { r = await pickLinks(page, goal, cfg.perPageLinks, seen, { signal: rs }); }
    catch (e) { if (!rs.aborted) emit("warn", { text: `link pick failed: ${e.message}` }); return; }
    jev(r);
    for (const p of r.picks) {
      const u = normalise(p.url);
      if (seen.has(u)) continue;
      seen.add(u);
      // A strong link off a strong page outranks a weak link off a strong one,
      // and both outrank a marginal search hit.
      enqueue({ url: u, text: p.text, host: p.host, parent: node.id, query: node.query, depth: c.depth + 1, prio: v.p * p.confidence });
    }
    bump(); notify();
  }

  // ------------------------------------------------------------ workers
  let stopNote = false;
  async function worker() {
    for (;;) {
      if (signal.aborted) return;
      maybeWiden();
      /* The target is a minimum, and reaching it is the point: nothing new
         is started after that, and pages still in flight simply finish. */
      const stop = stats.kept >= want ? "source target reached"
        : budgetLeft() <= 0 ? `page budget reached (${cfg.maxPages})` : null;
      if (stop) {
        if (!stopNote && frontier.length) { stopNote = true; emit("log", { text: `${stop} · ${frontier.length} queued pages left unread` }); }
        return;
      }
      const c = frontier.shift();
      if (!c) {
        if (expanding) { await expanding; continue; }
        if (inFlight === 0) return;
        await wait(); continue;
      }
      inFlight++; status();
      try { await processNode(c); }
      catch (e) { if (!rs.aborted) emit("warn", { text: `page failed: ${e.message}` }); }
      finally { inFlight--; }
      status();
      notify();
    }
  }

  // ------------------------------------------------------------- the run
  stats.wave = 1; bump();
  emit("phase", { text: "Searching", state: "live" });
  const seeded = await runSearches(planned.queries);
  reportEngines();
  if (!seeded) {
    emit("error", {
      text: health.answered.size
        ? (stats.triaged
            ? `${stats.triaged} results, none looked relevant from their snippets — try different wording`
            : `no results for any of the ${triedQueries.length} queries — try different wording`)
        : `every search engine refused: ${[...health.down].map(([e, r]) => `${e} (${r})`).join(", ") || "node returned nothing"}`,
    });
    return;
  }

  const workers = Promise.all(Array.from({ length: cfg.concurrency }, worker));
  const targetMet = new Promise(resolve => {
    const tick = setInterval(() => {
      if (stats.kept < want) return;
      clearInterval(tick);
      setTimeout(resolve, inFlight ? 1500 : 0);   // a moment for pages about to land
    }, 100);
    workers.finally(() => { clearInterval(tick); resolve(); }).catch(() => {});
  });
  await Promise.race([workers, targetMet]);
  if (signal.aborted) return;
  sealed = true;
  if (inFlightNodes.size) {
    emit("log", { text: `target met · ${inFlightNodes.size} page${inFlightNodes.size > 1 ? "s" : ""} still loading dropped` });
    for (const id of inFlightNodes) { nodes.delete(id); emit("node:drop", { id }); }
    inFlightNodes.clear();
    reading.abort();
  }
  if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }

  // ---------------------------------------------------------- 5. synthesis
  const sources = [...nodes.values()]
    .filter(n => n.kept && n.text)
    .sort((a, b) => b.p - a.p || a.depth - b.depth)
    .slice(0, cfg.maxSources);

  if (!sources.length) {
    emit("error", {
      text: stats.fetched === 0 ? "no page could be fetched at all"
        : stats.failed >= stats.fetched ? `all ${stats.fetched} pages failed to load (bot protection or client-rendered)`
        : `${stats.cut} pages loaded but none scored at or above ${cfg.threshold} — the results were off-topic`,
    });
    return;
  }
  if (sources.length < want) {
    emit("warn", { text: `finished with ${sources.length} of ${want} sources after ${stats.wave} batch${stats.wave > 1 ? "es" : ""} of queries` });
  }

  emit("phase", { text: `Gathering ${sources.length} sources`, state: "live" });
  emit("gather", { ids: sources.map(s => s.id) });

  const out = await report(goal, sources, {
    signal,
    onProgress: p => emit("phase", {
      text: p.stage === "outline" ? "Planning the report" : `Writing ${p.done}/${p.total} · ${p.heading}`,
      state: "live",
    }),
    onBegin: b => emit("report:begin", {
      ...b,
      sources: sources.map((s, i) => ({ n: i + 1, id: s.id, url: s.url, host: s.host, title: s.title, p: s.p, depth: s.depth })),
    }),
    /* One SSE message per token is thousands of messages and thousands of
       client-side parses. Tokens are coalesced into ~60 ms frames; a `done`
       flushes immediately so section boundaries stay exact. */
    onToken: (() => {
      let pend = new Map(), timer = null;
      const flush = () => {
        timer = null;
        for (const [i, text] of pend) if (text) emit("report:token", { i, text });
        pend.clear();
      };
      return t => {
        if (t.text) {
          pend.set(t.i, (pend.get(t.i) || "") + t.text);
          if (!timer) timer = setTimeout(flush, 60);
          return;
        }
        if (timer) { clearTimeout(timer); flush(); }
        emit("report:token", t);
      };
    })(),
  });
  if (signal.aborted) return;
  spend(out.usage); recost();

  const payload = {
    headline: out.headline,
    markdown: out.markdown,
    full: out.full,
    sources: sources.map((s, i) => ({ n: i + 1, id: s.id, url: s.url, host: s.host, title: s.title, p: s.p, depth: s.depth })),
    sections: out.sectionCount,
    stats: { ...stats, model: cfg.llmModel, jev: cfg.jevModel },
  };
  emit("report", payload);
  emit("phase", { text: "Run complete", state: "done" });
  emit("done", {});

  // Thumbnails still landing get a moment to make it into the saved run.
  await Promise.race([Promise.allSettled(shots), new Promise(r => setTimeout(r, 8000))]);

  return {
    nodes: [...nodes.values()].map(n => ({
      id: n.id, parent: n.parent, depth: n.depth, kind: n.kind, url: n.url, host: n.host,
      title: n.title, kept: !!n.kept, p: n.p ?? null, excerpt: n.excerpt || "", shot: n.shot || null,
      signals: n.signals || null, error: n.error || null,
    })),
    queries: [...queryYield].map(([query, v]) => ({ query, ...v })),
    report: payload,
    stats,
  };
}
