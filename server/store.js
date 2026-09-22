/**
 * Run history, on disk.
 *
 * A finished run is a JSON file: the question, the graph, the report and what
 * it cost. That is enough to put the whole canvas back without fetching
 * anything again, so opening a past run is instant and free.
 *
 * Thumbnails live beside it under data/shots/<id>/ and are deleted with it.
 */
import { mkdir, readdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { ROOT } from "./config.js";

const DIR = join(ROOT, "data", "runs");
const SHOTS = join(ROOT, "data", "shots");
const KEEP = 60;

await mkdir(DIR, { recursive: true }).catch(() => {});

export async function save(run) {
  await mkdir(DIR, { recursive: true });
  await writeFile(join(DIR, `${run.id}.json`), JSON.stringify(run), "utf8");
  await prune();
}

export async function load(id) {
  if (!/^[\w-]+$/.test(id)) return null;
  try { return JSON.parse(await readFile(join(DIR, `${id}.json`), "utf8")); }
  catch { return null; }
}

/** Newest first, enough for the history list and nothing more. */
export async function list() {
  let files;
  try { files = await readdir(DIR); } catch { return []; }
  const rows = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const r = JSON.parse(await readFile(join(DIR, f), "utf8"));
      rows.push({
        id: r.id, goal: r.goal, depth: r.depth, at: r.at,
        headline: r.report?.headline || "",
        kept: r.stats?.kept ?? 0, fetched: r.stats?.fetched ?? 0,
        cost: r.stats?.cost ?? 0, stopped: !!r.stopped,
      });
    } catch { /* a half-written file is skipped, not fatal */ }
  }
  return rows.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
}

export async function remove(id) {
  if (!/^[\w-]+$/.test(id)) return;
  await rm(join(DIR, `${id}.json`), { force: true }).catch(() => {});
  await rm(join(SHOTS, id), { recursive: true, force: true }).catch(() => {});
}

async function prune() {
  const rows = await list();
  for (const r of rows.slice(KEEP)) await remove(r.id);
}
