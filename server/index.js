/**
 * HTTP + SSE. Start a run with POST /api/run, watch it on GET /api/run/:id/events.
 *
 * Keys live in this process and nothing forwards them, so the page can be
 * served to anything on the LAN without handing out credentials.
 */
import express from "express";
import { join } from "node:path";
import { cfg, missing, ROOT } from "./config.js";
import { runCrawl } from "./crawl.js";
import * as store from "./store.js";
import { closeBrowser } from "./shots.js";

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static(join(ROOT, "client")));
// thumbnails captured during a run
app.use("/vendor", express.static(join(ROOT, "node_modules", "lucide", "dist", "umd"), { maxAge: "1d" }));
app.use("/shots", express.static(join(ROOT, "data", "shots"), { maxAge: "1h", fallthrough: true }));

/** id -> { events: [], clients: Set, ctrl: AbortController, done: bool } */
const runs = new Map();
let seq = 0;

function push(run, type, data) {
  const line = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  run.events.push(line);
  for (const res of run.clients) res.write(line);
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: missing().length === 0,
    missing: missing(),
    llm: cfg.llmModel,
    jev: cfg.jevModel,
    search: cfg.searxUrl,
    threshold: cfg.threshold,
    maxPages: cfg.maxPages,
    minSources: cfg.minSources,
    maxWaves: cfg.maxWaves,
  });
});

app.post("/api/run", (req, res) => {
  const gone = missing();
  if (gone.length) return res.status(500).json({ error: `missing ${gone.join(", ")} in .env` });

  const goal = String(req.body?.goal || "").trim();
  if (!goal) return res.status(400).json({ error: "goal is required" });
  const depth = Math.max(1, Math.min(50, Number(req.body?.depth) || 3));
  const minSources = Math.max(1, Math.min(50, Number(req.body?.minSources) || cfg.minSources));

  const id = `r${++seq}${Date.now().toString(36)}`;
  const run = { events: [], clients: new Set(), ctrl: new AbortController(), done: false };
  runs.set(id, run);

  const emit = (type, data) => push(run, type, data);
  runCrawl({ goal, depth, minSources, emit, signal: run.ctrl.signal, runId: id })
    .then(async result => {
      // a finished run is saved whole, so history can put the canvas back
      // without fetching or paying for anything again
      if (!result) return;
      await store.save({ id, goal, depth, minSources, at: new Date().toISOString(),
        stopped: run.ctrl.signal.aborted, ...result }).catch(() => {});
    })
    .catch(e => { if (!run.ctrl.signal.aborted) emit("error", { text: e.message }); })
    .finally(() => {
      run.done = true;
      emit("end", {});
      for (const c of run.clients) c.end();
      run.clients.clear();
      // keep the transcript briefly so a reconnecting page can replay it
      setTimeout(() => runs.delete(id), 10 * 60_000);
    });

  res.json({ id, goal, depth, minSources });
});

app.get("/api/run/:id/events", (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).end();

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": open\n\n");
  for (const line of run.events) res.write(line);      // replay whatever already happened
  if (run.done) return res.end();

  run.clients.add(res);
  const beat = setInterval(() => res.write(": beat\n\n"), 20_000);
  req.on("close", () => { clearInterval(beat); run.clients.delete(res); });
});

app.get("/api/run/:id/status", (req, res) => {
  const run = runs.get(req.params.id);
  res.json({ alive: !!run && !run.done, known: !!run });
});

app.post("/api/run/:id/stop", (req, res) => {
  const run = runs.get(req.params.id);
  if (run) { run.ctrl.abort(); push(run, "phase", { text: "Stopped", state: "" }); }
  res.json({ ok: true });
});

/* A board has its own URL. The path is handled entirely in the client; the
   server just needs to serve the app for it instead of 404ing. */
app.get("/r/:id", (_req, res) => res.sendFile(join(ROOT, "client", "index.html")));

app.get("/api/runs", async (_req, res) => res.json(await store.list()));

app.get("/api/runs/:id", async (req, res) => {
  const run = await store.load(req.params.id);
  if (!run) return res.status(404).json({ error: "no such run" });
  res.json(run);
});

app.delete("/api/runs/:id", async (req, res) => {
  await store.remove(req.params.id);
  res.json({ ok: true });
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => { await closeBrowser(); process.exit(0); });
}

app.listen(cfg.port, "127.0.0.1", () => {
  const gone = missing();
  console.log(`unfold → http://localhost:${cfg.port}`);
  console.log(`  llm    ${cfg.llmModel}`);
  console.log(`  jev    ${cfg.jevModel}  (keep at relevance ≥ ${cfg.threshold})`);
  console.log(`  search ${cfg.searxUrl}`);
  if (gone.length) console.log(`  ⚠ missing ${gone.join(", ")} — runs will fail`);
});
