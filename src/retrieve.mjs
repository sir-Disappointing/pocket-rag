// Picks the pieces of a knowledge base that fit a question, so not everything has to be sent.
// Used in the browser (own key) and in the Worker (proxy). No dependencies.
//
// How it works: BM25 scoring over the chunks, with per-language stopwords and word variants.
// Longer words also match inside compounds ("park" in "parking", "voorrang" in "voorrangsweg").
// Synonyms translate everyday words into the words used in the content. Chunk keys (a sign code,
// an article number, a product id) that appear literally in the question always come along.
import * as en from "./lang/en.mjs";
import * as nl from "./lang/nl.mjs";

export const LANGS = { en, nl };

const DEFAULTS = { maxChunks: 10, maxChars: 7000, minRatio: 0.3, boost: {} };
const K1 = 1.2;
const B = 0.75;

export function lang(knowledge) {
  return LANGS[knowledge.lang] || en;
}

export function normalize(text) {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function words(text) {
  return normalize(text).match(/[a-z0-9]+/g) || [];
}

export function keyOf(text) {
  return normalize(text).replace(/[^a-z0-9]/g, "");
}

// The meaningful words of a question, each with the variants the search tries.
export function contentWords(knowledge, text) {
  const L = lang(knowledge);
  return words(text)
    .filter((w) => !L.stop.has(w) && !extraStop(knowledge).has(w) && w.length >= 2)
    .map((w) => ({ word: w, variants: [...new Set([...L.variants(w), ...(/\d/.test(w) ? [w] : [])])] }));
}

// Your own stopwords: words that appear everywhere in your content and so say nothing.
const stopCache = new WeakMap();
function extraStop(knowledge) {
  let set = stopCache.get(knowledge);
  if (!set) stopCache.set(knowledge, (set = new Set((knowledge.stopwords || []).map(normalize))));
  return set;
}

function queryTerms(knowledge, text) {
  const L = lang(knowledge);
  const synonyms = { ...L.synonyms, ...(knowledge.synonyms || {}) };
  const terms = new Map(); // term → weight
  const add = (t, w) => terms.set(t, Math.max(terms.get(t) || 0, w));
  for (const raw of words(text)) {
    if (L.stop.has(raw) || extraStop(knowledge).has(raw) || raw.length < 2) continue;
    for (const v of L.variants(raw)) add(v, 1);
    if (/\d/.test(raw)) add(raw, 1);
    for (const syn of synonyms[raw] || []) {
      const s = normalize(syn);
      if (s.includes(" ")) add(s, 0.8);
      else for (const v of L.variants(s)) add(v, 0.8);
    }
  }
  // Phrases the content author mapped to a word, e.g. "who goes first" → "priority".
  for (const [phrase, targets] of Object.entries(knowledge.phrases || {})) {
    if (` ${words(text).join(" ")} `.includes(` ${words(phrase).join(" ")} `)) for (const t of targets) add(normalize(t), 1);
  }
  return terms;
}

const indexCache = new WeakMap();

function index(knowledge) {
  let idx = indexCache.get(knowledge);
  if (idx) return idx;
  const docs = knowledge.chunks.map((c) => {
    const title = words(c.title).join(" ");
    // The title counts twice.
    const text = ` ${title} ${title} ${words(c.text).join(" ")} `;
    return { chunk: c, text, len: text.split(" ").length };
  });
  const avgLen = docs.reduce((n, d) => n + d.len, 0) / Math.max(1, docs.length);
  const keys = new Map();
  for (const c of knowledge.chunks) {
    for (const k of c.keys || []) {
      const key = keyOf(k);
      if (key) keys.set(key, (keys.get(key) || []).concat(c));
    }
  }
  idx = { docs, avgLen, keys, df: new Map() };
  indexCache.set(knowledge, idx);
  return idx;
}

function count(haystack, needle) {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

// Short terms only match at the start of a word, otherwise "rem" would also find "extreem".
function occurrences(text, term) {
  return term.length <= 4 ? count(text, ` ${term}`) : count(text, term);
}

// Chunks whose key appears literally in the question ("B6", "B 6", "art. 15").
function directHits(knowledge, question) {
  const idx = index(knowledge);
  if (!idx.keys.size) return [];
  const L = lang(knowledge);
  const found = new Set();
  const text = normalize(question);
  for (const w of words(text)) found.add(w);
  for (const m of text.matchAll(L.keyJoin)) found.add(m[1] + m[2]);
  for (const m of text.matchAll(/[a-z0-9][a-z0-9._/-]*[a-z0-9]/g)) found.add(keyOf(m[0]));
  const out = [];
  for (const k of found) for (const c of idx.keys.get(k) || []) if (!out.includes(c)) out.push(c);
  return out;
}

export function retrieve(knowledge, question, previous = "") {
  return explain(knowledge, question, previous).picked;
}

// The whole search with its reasons: which terms were searched, which chunks scored and why,
// and which were picked. `pocket-rag ask` and `pocket-rag check` show this.
export function explain(knowledge, question, previous = "") {
  const tuning = { ...DEFAULTS, ...(knowledge.tuning || {}) };
  const idx = index(knowledge);
  const terms = queryTerms(knowledge, question);
  // In a follow-up ("and on Sundays?") the previous question counts at half weight.
  for (const [t, w] of queryTerms(knowledge, previous)) if (!terms.has(t)) terms.set(t, w * 0.5);

  const n = idx.docs.length;
  const scores = idx.docs.map(() => 0);
  const matched = idx.docs.map(() => []);
  const termInfo = [];
  for (const [term, weight] of terms) {
    const tfs = idx.docs.map((d) => occurrences(d.text, term));
    let df = idx.df.get(term);
    if (df === undefined) {
      df = tfs.filter(Boolean).length;
      idx.df.set(term, df);
    }
    termInfo.push({ term, weight, df });
    if (!df) continue;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    tfs.forEach((tf, i) => {
      if (!tf) return;
      const d = idx.docs[i];
      scores[i] += weight * idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d.len) / idx.avgLen)));
      matched[i].push(term);
    });
  }

  // Optional preference per id prefix, e.g. { "guide/": 1.25 } for plain-language pages.
  const boosts = Object.entries(tuning.boost);
  if (boosts.length) {
    idx.docs.forEach((d, i) => {
      for (const [prefix, factor] of boosts) if (d.chunk.id.startsWith(prefix)) scores[i] *= factor;
    });
  }

  const ranked = idx.docs
    .map((d, i) => ({ chunk: d.chunk, score: scores[i], terms: matched[i] }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
  const top = ranked.length ? ranked[0].score : 0;
  const cutoff = top * tuning.minRatio;

  const picked = [];
  let chars = 0;
  const take = (c) => {
    if (picked.includes(c) || picked.length >= tuning.maxChunks) return;
    const size = c.title.length + c.text.length;
    if (picked.length && chars + size > tuning.maxChars) return;
    picked.push(c);
    chars += size;
  };
  const keyHits = directHits(knowledge, question);
  keyHits.forEach(take);
  for (const r of ranked) {
    if (r.score < cutoff) break;
    take(r.chunk);
  }
  return { terms: termInfo, keyHits, ranked, cutoff, picked, tuning };
}

// The fixed core as the system prompt. It is the same every time, so it gets cached.
export function systemBlocks(knowledge) {
  return [{ type: "text", text: knowledge.core, cache_control: { type: "ephemeral" } }];
}

// Puts the matching sources with the last question. Earlier questions go without sources.
//
// In a follow-up, the previous answer gets a cache marker. Everything up to that answer (core plus
// earlier turns) is identical in the next request and then costs a tenth. Marking the last question
// itself is pointless: next time it is sent without its sources and looks different.
export function withSources(knowledge, messages) {
  const S = lang(knowledge).strings;
  const users = messages.filter((m) => m.role === "user");
  const question = users[users.length - 1].content;
  const previous = users.length > 1 ? users[users.length - 2].content : "";
  const sources = retrieve(knowledge, question, previous);
  const block = sources.length
    ? sources.map((c) => `<${S.sourceTag} ${S.titleAttr}="${c.title.replace(/"/g, "'")}">\n${c.text}\n</${S.sourceTag}>`).join("\n")
    : S.noSources;
  const last = `${S.sourcesOpen}\n${block}\n${S.sourcesClose}\n\n${S.questionOpen}\n${question}\n${S.questionClose}`;
  const out = messages.slice(0, -1).concat({ role: "user", content: last });
  if (out.length >= 3) {
    const prev = out[out.length - 2];
    out[out.length - 2] = { role: prev.role, content: [{ type: "text", text: prev.content, cache_control: { type: "ephemeral" } }] };
  }
  return out;
}

// The request body both the browser and the Worker send to Anthropic.
export function requestBody(knowledge, settings, messages) {
  const body = {
    model: settings.model,
    max_tokens: settings.maxTokens,
    system: systemBlocks(knowledge),
    messages: withSources(knowledge, messages),
    stream: true,
  };
  if (settings.effort) body.output_config = { effort: settings.effort };
  return body;
}
