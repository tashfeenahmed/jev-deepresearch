/**
 * Jev — every decision in the crawl that is a choice between known options.
 *
 * Two calls, and the split is the whole design:
 *
 *   judge(page)   one request, four typed questions answered in parallel.
 *                 Returns calibrated probabilities; code applies the
 *                 threshold, so the model never decides policy.
 *
 *   pickLinks()   one request carrying a yes/no PER LINK, all answered in the
 *                 same forward pass. Code ranks the probabilities and takes the
 *                 top few. Jev never writes a URL — it only scores ones the
 *                 page already contained, which is the same reason
 *                 jev-ultrafast hands it element ids rather than coordinates.
 *
 * No text is generated anywhere in this file.
 */
import { cfg } from "./config.js";

const noul   = (instructions) => ({ type: "noul", instructions });

async function systemOne(state, questions, signal) {
  const t0 = performance.now();
  const body = JSON.stringify({ state, questions, model: cfg.jevModel });
  // A rate limit or a 5xx on one page should cost a second try, not the page.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${cfg.jevUrl}/v1/systemone`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.jevKey}` },
      body,
    }).catch(e => { if (attempt === 0 && !signal?.aborted) return null; throw e; });
    if (!res || (res.status === 429 || res.status >= 500) && attempt === 0) {
      await new Promise(r => setTimeout(r, 400 + Math.random() * 400));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Jev ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    return {
      answers: data.answers, ms: Math.round(performance.now() - t0),
      tokens: data.usage?.input_tokens ?? 0,
    };
  }
}

/** Is this page worth keeping, and worth crawling deeper from? */
export async function judge(page, goal, { signal } = {}) {
  const state = {
    goal,
    page: { url: page.url, host: page.host, title: page.title },
    excerpt: page.text.slice(0, 4000),
  };

  const questions = {
    on_topic: noul("The page is about the subject of `goal`, not merely mentioning a word from it."),
    has_primary_data: noul(
      "The page carries something first-hand a report could cite: numbers, a benchmark, a measurement, " +
      "a specification, documentation, source code, or an author's own account. Press coverage that only " +
      "repeats someone else's announcement does not count."),
    worth_expanding: noul("Following this page's own links is likely to reach further useful sources."),
    relevance: {
      type: "score",
      instructions: "How useful is this page for answering `goal`?",
      criteria: [
        "Useless: off-topic, a stub, a login wall, or an error page",
        "Thin: on topic but adds nothing a better source does not already say",
        "Useful: a real contribution — some detail, data or argument worth citing",
        "Essential: a primary source the answer would be wrong to leave out",
      ],
    },
  };

  const { answers, ms, tokens } = await systemOne(state, questions, signal);

  // `relevance` is an expected level in 0..3; normalise to 0..1 so one
  // threshold covers it and the bars in the UI mean the same thing everywhere.
  const level = Number(answers.relevance?.score ?? 0);
  const p = Math.max(0, Math.min(1, level / 3));

  return {
    p: +p.toFixed(3),
    level,
    kept: p >= cfg.threshold,
    signals: {
      on_topic: +(answers.on_topic?.noul ?? 0).toFixed(3),
      has_primary_data: +(answers.has_primary_data?.noul ?? 0).toFixed(3),
      worth_expanding: +(answers.worth_expanding?.noul ?? 0).toFixed(3),
      relevance: +p.toFixed(3),
    },
    confidence: +(answers.relevance?.confidence ?? 0).toFixed(3),
    ms,
    tokens,
    calls: 1,
  };
}

/**
 * Choose which links to follow — in ONE request.
 *
 * The obvious shape is a `choice` over the links, asked once per pick with the
 * chosen index removed. That is three round trips for three links, and it
 * wastes what Jev actually is: every question in a request is answered in the
 * same parallel forward pass. Forty `noul`s cost the same 650 ms as one.
 *
 * So each candidate link gets its own yes/no, they are all asked together, and
 * code ranks the calibrated probabilities and takes the top few. That is also a
 * better answer than a sequence of argmaxes: it says how good each link is,
 * not merely which was least bad.
 */
export async function pickLinks(page, goal, want, seenUrls, { signal } = {}) {
  const pool = page.links.filter(l => !seenUrls.has(l.url)).slice(0, 40);
  if (!pool.length) return { picks: [], ms: 0, calls: 0, tokens: 0 };

  const questions = {};
  pool.forEach((l, i) => {
    questions[`l${i}`] = noul(
      `Following the link "${l.text}" (on ${l.host}) would reach a page that helps answer \`goal\`. ` +
      "Primary sources, documentation, specifications, data and first-hand accounts count. " +
      "Navigation, marketing, sign-up pages, and pages that only repeat what the current page " +
      "already says do not.");
  });

  const state = {
    goal,
    current_page: { url: page.url, title: page.title },
    links: pool.map((l, i) => `l${i} "${l.text}" → ${l.host}`),
  };

  const { answers, ms, tokens } = await systemOne(state, questions, signal);

  const picks = pool
    .map((l, i) => ({ ...l, confidence: +(answers[`l${i}`]?.noul ?? 0).toFixed(3) }))
    .filter(l => l.confidence >= 0.5)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, want);

  return { picks, ms, calls: 1, tokens };
}

/**
 * Rank search results before anything is fetched — in ONE request.
 *
 * A search hit already says what it is: a title, a host, a snippet. Fetching
 * it costs one of the crawl's slots for anything from a second to forty (bot
 * protection, then the browser fallback), and judging it costs a Jev call
 * with 4,000 characters of state. Scoring the snippet first costs a fraction
 * of that for every hit in the batch at once, so the ones that were never
 * going to be kept are never read, and the strongest are read first.
 *
 * Returns a probability per hit, in the order given.
 */
export async function triage(hits, goal, { signal } = {}) {
  const p = new Array(hits.length).fill(0.5);
  let ms = 0, tokens = 0, calls = 0;
  for (let start = 0; start < hits.length; start += 40) {
    const batch = hits.slice(start, start + 40);
    const questions = {};
    batch.forEach((_, i) => {
      questions[`h${i}`] = noul(
        `Search result h${i} is a page that would help answer \`goal\` — on the subject, and likely ` +
        "to carry something citable: data, documentation, a specification, source code, a first-hand " +
        "account, or a real argument. A stub, a listing page, a login wall, or a page that only " +
        "mentions a word from the goal does not.");
    });
    const state = {
      goal,
      results: batch.map((h, i) => `h${i} [${h.host}] "${h.text}" — ${h.snippet || "(no snippet)"}`),
    };
    const r = await systemOne(state, questions, signal);
    batch.forEach((_, i) => { p[start + i] = +(r.answers[`h${i}`]?.noul ?? 0.5).toFixed(3); });
    ms += r.ms; tokens += r.tokens; calls++;
  }
  return { p, ms, tokens, calls };
}
