/**
 * Qwen 3.6 Plus, through OpenRouter — the two jobs that need generated text.
 *
 *   plan()    turn one question into the search queries that will find it
 *   report()  write the synthesis from the pages Jev kept
 *
 * Everything between those — which pages are relevant, which links to follow —
 * is Jev's, and no LLM sees it. That is the point of the architecture: the
 * expensive model is called twice per run, not once per page.
 */
import { cfg } from "./config.js";

async function chat(messages, { json = false, maxTokens = 3000, signal } = {}) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.llmKey}`,
      "x-title": "Unfold",
    },
    body: JSON.stringify({
      model: cfg.llmModel,
      messages,
      max_tokens: maxTokens,
      temperature: 0.3,
      // Qwen 3.6 is a reasoning model: left alone it spends the whole
      // completion budget thinking and returns empty content. Off, it is
      // ~20x cheaper and answers directly. Set LLM_REASONING=on to allow it.
      ...(process.env.LLM_REASONING === "on" ? {} : { reasoning: { enabled: false } }),
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  const text = (msg?.content || "").trim();
  if (!text) throw new Error("model returned no content");
  return { text, usage: data.usage || {} };
}

/** Same call, but tokens are handed over as they arrive. */
async function chatStream(messages, { maxTokens = 3000, signal }, onToken) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.llmKey}`,
      "x-title": "Unfold",
    },
    body: JSON.stringify({
      model: cfg.llmModel, messages, max_tokens: maxTokens, temperature: 0.3, stream: true,
      ...(process.env.LLM_REASONING === "on" ? {} : { reasoning: { enabled: false } }),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", text = "", usage = {};
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    // SSE frames are separated by a blank line; a frame can split across reads
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      let j;
      try { j = JSON.parse(payload); } catch { continue; }
      if (j.usage) usage = j.usage;
      const delta = j.choices?.[0]?.delta?.content;
      if (delta) { text += delta; onToken?.(delta); }
    }
  }
  return { text, usage };
}

/** One question in; the searches that will actually find the answer out. */
export async function plan(goal, { signal } = {}) {
  const { text, usage } = await chat([
    { role: "system", content:
      "You turn a research question into web searches. Reply with JSON only: " +
      '{"queries":["...","..."],"angle":"one sentence on what a good answer needs"}. ' +
      "Give 4 to 6 queries.\n" +
      "CRITICAL: keep proper nouns, product names, version numbers and unusual capitalisation " +
      "EXACTLY as the user wrote them. An odd-looking term is almost always the name of a " +
      "specific thing, not a concept to reinterpret — searching for what you think it means " +
      "instead of what it says returns nothing useful. Never expand, translate or generalise a name.\n" +
      "Otherwise make them the phrases someone who knows the field would type: specific names, " +
      "versions, file names, benchmark names. Vary the angle across queries rather than " +
      "paraphrasing the question. No boolean operators, no site: filters." },
    { role: "user", content: goal },
  ], { json: true, maxTokens: 700, signal });

  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  const queries = Array.isArray(parsed.queries)
    ? parsed.queries.filter(q => typeof q === "string" && q.trim()).slice(0, 5)
    : [];
  // The user's own wording always goes in. If they named something the model
  // does not recognise, this is the query that still finds it.
  const seeded = [goal, ...queries.filter(q => q.toLowerCase() !== goal.toLowerCase())];
  return {
    queries: seeded.slice(0, 6),
    angle: typeof parsed.angle === "string" ? parsed.angle : "",
    usage,
  };
}

/**
 * The report, in two passes.
 *
 * One call asked to write everything at once produces a summary, whatever the
 * token budget: the model spreads a fixed amount of attention over every
 * source and lands on the things they all agree about. So instead:
 *
 *   outline()   reads every source's opening and decides the sections, and
 *               which sources belong to each one.
 *   section()   writes ONE section, given the FULL text of only its own
 *               sources and a budget to itself.
 *
 * Each section therefore gets the attention a whole report used to get, and a
 * source that only matters to one section is read closely rather than skimmed.
 */

/** Plan the report: what the sections are, and which sources feed each. */
async function outline(goal, sources, { signal } = {}) {
  const catalog = sources.map((s, i) =>
    `[${i + 1}] ${s.title} — ${s.host} (relevance ${s.p.toFixed(2)})\n${s.text.slice(0, 1200).replace(/\n+/g, " ")}`
  ).join("\n\n");

  const { text, usage } = await chat([
    { role: "system", content:
      "You are planning a detailed research report. You will be given every source that was gathered.\n" +
      "Reply with JSON only:\n" +
      '{"headline":"<8-14 words, the finding itself>",' +
      '"sections":[{"heading":"<2-5 words>","brief":"<one sentence on what this section must establish>",' +
      '"form":"prose"|"table","rows":["<thing compared>",...],"axes":["<axis>",...],' +
      '"use":[1,4,9]}]}\n' +
      "Rules:\n" +
      "- Give 5 to 8 sections. Order them so the report builds an argument.\n" +
      "- `form` is \"table\" when the section sets two or more things side by side on the same axes — " +
      "products, approaches, versions, options, studies. Then `rows` names the things and `axes` the " +
      "3 to 6 attributes they are compared on. If the QUESTION itself compares things, at least one " +
      "section MUST be a table. Otherwise `form` is \"prose\" and `rows`/`axes` are omitted.\n" +
      "- `use` lists the source numbers that section should be written from. A source may appear in " +
      "several sections, and every source worth citing should appear in at least one.\n" +
      "- Sections must be about the SUBJECT, not about the research. Never a section called " +
      "'Overview', 'Introduction', 'Methodology' or 'Conclusion'.\n" +
      "- Make sections cut the subject at its real joints — the distinct mechanisms, the competing " +
      "positions, the numbers, the practical consequences.\n" +
      "- The LAST section must be 'Still open': what the sources do not settle." },
    { role: "user", content: `QUESTION\n${goal}\n\nSOURCES\n\n${catalog}` },
  ], { json: true, maxTokens: 2000, signal });

  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  const secs = Array.isArray(parsed.sections) ? parsed.sections : [];
  return {
    headline: typeof parsed.headline === "string" && parsed.headline ? parsed.headline : goal,
    sections: secs
      .filter(x => x && typeof x.heading === "string")
      .map(x => ({
        heading: x.heading.slice(0, 60),
        brief: typeof x.brief === "string" ? x.brief : "",
        form: x.form === "table" && Array.isArray(x.rows) && Array.isArray(x.axes) ? "table" : "prose",
        rows: (Array.isArray(x.rows) ? x.rows : []).filter(r => typeof r === "string").slice(0, 12),
        axes: (Array.isArray(x.axes) ? x.axes : []).filter(a => typeof a === "string").slice(0, 6),
        use: (Array.isArray(x.use) ? x.use : [])
          .map(Number).filter(n => n >= 1 && n <= sources.length),
      }))
      .slice(0, 8),
    usage,
  };
}

/** Write one section from the full text of the sources assigned to it. */
async function section(goal, sec, sources, others, { signal, onToken } = {}) {
  const use = sec.use.length ? sec.use : sources.map((_, i) => i + 1);
  const corpus = use.map(n => {
    const s = sources[n - 1];
    return `[${n}] ${s.title} — ${s.host}\n${s.text.slice(0, 9000)}`;
  }).join("\n\n---\n\n");

  const table = sec.form === "table";
  const shape = table
    ? "- This section is a COMPARISON. It MUST open with a markdown table: one row per thing compared " +
      `(${sec.rows.join(", ")}), one column per axis (${sec.axes.join(", ")}). Every cell holds a ` +
      "specific value with its citation [n], or 'not stated' — never a vague word. After the table, " +
      "150 to 350 words on what the table shows: where the differences are decisive, and where the " +
      "sources disagree about a cell.\n"
    : "- 300 to 700 words of prose. Use a markdown table only if you find yourself listing the same " +
      "attributes for three or more things.\n";
  const { text, usage } = await chatStream([
    { role: "system", content:
      "You write ONE section of a research report, in markdown. You are given the full text of the " +
      "sources for this section.\n" +
      "Rules:\n" +
      "- Do NOT write the heading; it is added for you. Start with the first paragraph" +
      (table ? " or the table" : "") + ".\n" +
      shape +
      "- Be specific and dense: real numbers, versions, names, file names, " +
      "quoted phrases. A sentence that would be true of any subject does not belong.\n" +
      "- Cite [n] inline on the specific claim, using the numbers shown on the sources.\n" +
      "- Where sources disagree, name which and say why, rather than averaging them.\n" +
      "- Use ONLY these sources. If they do not settle something, say so in one clause and move on.\n" +
      "- Never repeat what other sections cover; they are listed for you.\n" +
      "- No preamble, no 'This section', no summary sentence at the end.\n" +
      "Reply with the markdown only — no JSON, no code fence." },
    { role: "user", content:
      `QUESTION\n${goal}\n\nTHIS SECTION\n${sec.heading} — ${sec.brief}` +
      (table ? `\nFORM: table · rows: ${sec.rows.join(" | ")} · axes: ${sec.axes.join(" | ")}` : "") +
      `\n\nOTHER SECTIONS (do not cover these)\n${others}\n\nSOURCES\n\n${corpus}` },
  ], { maxTokens: 2600, signal }, onToken);

  return { md: text.replace(/^```(?:markdown|md)?\n?|\n?```$/g, "").trim(), usage };
}

export async function report(goal, sources, { signal, onProgress, onBegin, onToken } = {}) {
  const usages = [];
  onProgress?.({ stage: "outline" });
  const plan = await outline(goal, sources, { signal });
  usages.push(plan.usage);

  const secs = plan.sections.length ? plan.sections
    : [{ heading: "Findings", brief: "What the sources establish.", form: "prose", rows: [], axes: [], use: [] },
       { heading: "Still open", brief: "What the sources do not settle.", form: "prose", rows: [], axes: [], use: [] }];

  // The reader now knows the shape before a word of it exists.
  onBegin?.({ headline: plan.headline, headings: secs.map(x => x.heading) });

  /* Sections are generated three at a time, but they REACH THE READER STRICTLY
     IN ORDER. Only the section at the cursor streams through live; the ones
     running ahead of it buffer, and flush the instant the cursor reaches them.
     So the page fills top to bottom at full speed, with none of the
     three-things-typing-at-once confusion of raw parallel streaming. */
  const bodies = new Array(secs.length);
  const buffered = secs.map(() => "");
  const finished = secs.map(() => false);
  let cursor = 0;

  const advance = () => {
    while (cursor < secs.length && finished[cursor]) {
      if (buffered[cursor]) { onToken?.({ i: cursor, text: buffered[cursor] }); buffered[cursor] = ""; }
      onToken?.({ i: cursor, done: true });
      cursor++;
      if (cursor < secs.length && buffered[cursor]) {
        onToken?.({ i: cursor, text: buffered[cursor] });   // catch the reader up
        buffered[cursor] = "";
      }
    }
  };

  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, secs.length) }, async () => {
    while (next < secs.length) {
      const i = next++;
      const others = secs.filter((_, j) => j !== i).map(x => `- ${x.heading}`).join("\n");
      try {
        const r = await section(goal, secs[i], sources, others, {
          signal,
          onToken: t => {
            if (i === cursor) onToken?.({ i, text: t });
            else buffered[i] += t;
          },
        });
        bodies[i] = r.md; usages.push(r.usage);
      } catch (e) {
        bodies[i] = `_Could not write this section: ${e.message}_`;
        buffered[i] = bodies[i];
      }
      finished[i] = true;
      advance();
      onProgress?.({ stage: "section", done: finished.filter(Boolean).length, total: secs.length, heading: secs[i].heading });
    }
  }));
  advance();

  const md = secs.map((x, i) => `## ${x.heading}\n\n${bodies[i] || ""}`).join("\n\n");

  // References come from the crawl, not the model — it cannot mis-transcribe a
  // URL it never had to write out.
  const refs = sources.map((s, i) =>
    `${i + 1}. [${s.title.replace(/[\[\]]/g, "")}](${s.url}) — ${s.host}, relevance ${s.p.toFixed(2)}, depth ${s.depth}`
  ).join("\n");

  const usage = usages.reduce((a, u) => ({
    cost: (a.cost || 0) + Number(u?.cost || 0),
    completion_tokens: (a.completion_tokens || 0) + Number(u?.completion_tokens || 0),
    calls: (a.calls || 0) + 1,
  }), {});

  const full = `# ${plan.headline}\n\n_${goal}_\n\n${md}\n\n## References\n\n${refs}\n`;
  return { headline: plan.headline, markdown: md, full, usage, sectionCount: secs.length };
}

/**
 * Short of sources, and the queue is running thin. Write new searches,
 * informed by the yield of every query so far.
 *
 * The model sees the whole table — how many pages each query found, how many
 * Jev kept, cut, could not load, or never bothered fetching — plus which hosts
 * the keepers came from and what they were titled. It borrows the vocabulary
 * that produced keepers and points it somewhere the crawl has not been.
 *
 * This is called WHILE the crawl is still reading, so `pending` lists queries
 * whose pages have not been judged yet; the model must not re-issue those.
 */
export async function expand(goal, evidence, need, { signal } = {}) {
  const table = evidence.rows.map(r =>
    `"${r.query}" → ${r.found} found · ${r.kept} kept · ${r.cut} cut` +
    (r.failed ? ` · ${r.failed} unreachable` : "") +
    (r.triaged ? ` · ${r.triaged} skipped as off-topic` : "")
  ).join("\n") || "(nothing judged yet)";
  const pending = evidence.pending.map(q => `"${q}"`).join(", ") || "(none)";
  const hosts = evidence.hosts.join(", ") || "(none yet)";
  const have = evidence.titles.map(t => `- ${t}`).join("\n") || "(nothing yet)";

  const { text, usage } = await chat([
    { role: "system", content:
      "You are widening a web research crawl that is running short of sources.\n" +
      'Reply with JSON only: {"queries":["...","..."],"why":"one sentence on the angle you are opening"}.\n' +
      "Rules:\n" +
      "- Give 4 to 6 NEW queries. Never repeat or lightly rephrase one in the table or in the pending list.\n" +
      "- Read the yield table. Queries with a high kept/found ratio show the vocabulary the good " +
      "sources use — borrow that vocabulary, then point it somewhere new. Queries with kept=0 are " +
      "a dead vocabulary; do not reuse their wording. 'unreachable' means the pages existed but " +
      "would not load — that vocabulary may still be right, so try it against a different kind of site.\n" +
      "- The hosts that produced keepers tell you what KIND of source works (a docs site, a paper " +
      "index, a forum, a vendor). Aim new queries at more of that kind, and at kinds not yet tried.\n" +
      "- Go sideways, not deeper: adjacent terms, the names of specific tools, people, papers, " +
      "file names, error strings, competitors, the opposing view, the primary source behind a summary.\n" +
      "- Keep proper nouns and version numbers EXACTLY as written. Never generalise a name.\n" +
      "- No boolean operators, no site: filters." },
    { role: "user", content:
      `QUESTION\n${goal}\n\nYIELD SO FAR\n${table}\n\nPENDING (searched, not yet judged)\n${pending}\n\n` +
      `HOSTS THAT PRODUCED KEEPERS\n${hosts}\n\nALREADY READ\n${have}\n\nSTILL NEED\n${need} more relevant sources.` },
  ], { json: true, maxTokens: 700, signal });

  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return {
    queries: Array.isArray(parsed.queries)
      ? parsed.queries.filter(q => typeof q === "string" && q.trim()).map(q => q.trim()).slice(0, 6)
      : [],
    why: typeof parsed.why === "string" ? parsed.why : "",
    usage,
  };
}
