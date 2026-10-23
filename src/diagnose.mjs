// Tools to see and fix what the assistant does:
//   ask     which chunks a question gets, and why
//   check   run checks.json; for each miss, say why and suggest a fix
//   doctor  check the whole setup of a site, with a fix for every problem
// Every report is plain data, so `--json` can hand it to a script or an AI assistant as is.
import fs from "node:fs";
import path from "node:path";
import { explain, contentWords, lang } from "./retrieve.mjs";
import { loadConfig, makeKnowledge, makeSettings, contentFiles } from "./build.mjs";
import { detect, sourceFiles } from "./detect.mjs";

const TOKENS = (chars) => Math.round(chars / 3.8);
const size = (c) => c.title.length + c.text.length;

// ------------------------------------------------------------ ask

const hasSynonym = (knowledge, word) => Boolean((knowledge.synonyms || {})[word] || lang(knowledge).synonyms[word]);

export function ask(knowledge, question, previous = "") {
  const ex = explain(knowledge, question, previous);
  const picked = new Set(ex.picked.map((c) => c.id));
  return {
    question,
    ...(previous ? { previous } : {}),
    terms: ex.terms.map((t) => ({ ...t, weight: Math.round(t.weight * 100) / 100 })),
    // Words nobody wrote in the content and that have no synonym yet: candidates for "synonyms".
    notInContent: [...new Set(contentWords(knowledge, question).filter((w) => !w.variants.some((v) => ex.terms.find((t) => t.term === v && t.df)) && !hasSynonym(knowledge, w.word)).map((w) => w.word))],
    keyHits: ex.keyHits.map((c) => c.id),
    cutoff: Math.round(ex.cutoff * 100) / 100,
    ranked: ex.ranked.slice(0, 15).map((r, i) => ({ rank: i + 1, id: r.chunk.id, title: r.chunk.title, score: Math.round(r.score * 100) / 100, matched: r.terms, sent: picked.has(r.chunk.id) })),
    sent: ex.picked.map((c) => ({ id: c.id, title: c.title, tokens: TOKENS(size(c)) })),
    sentTokens: TOKENS(ex.picked.reduce((n, c) => n + size(c), 0)),
  };
}

export function formatAsk(r) {
  const lines = [`Question: ${r.question}${r.previous ? `\n(previous: ${r.previous})` : ""}`, ""];
  lines.push(`Search terms: ${r.terms.map((t) => `${t.term}${t.weight < 1 ? `×${t.weight}` : ""}${t.df ? ` (${t.df})` : " (nowhere)"}`).join(", ") || "(none: only stopwords)"}`);
  if (r.notInContent.length) lines.push(`Not in your content: ${r.notInContent.join(", ")}. Add a synonym if visitors use these words.`);
  if (r.keyHits.length) lines.push(`Key hits: ${r.keyHits.join(", ")}`);
  lines.push("", `Best matches (sent if score ≥ ${r.cutoff}):`);
  for (const x of r.ranked) lines.push(`${x.sent ? "→" : " "} ${String(x.rank).padStart(2)}. ${x.score.toFixed(2).padStart(6)}  ${x.id}  [${x.matched.join(", ")}]`);
  if (!r.ranked.length) lines.push("   (no chunk matches)");
  lines.push("", `Sent: ${r.sent.length} chunks, ~${r.sentTokens} tokens.`);
  return lines.join("\n");
}

// ------------------------------------------------------------ check

const matches = (id, e) => id === e || id.startsWith(e);

// Words from a chunk's own heading: what a synonym should point to. Intro sections have none.
function headingWords(knowledge, chunk) {
  if (!chunk.title.includes("›")) return [];
  const heading = chunk.title.split("›").pop().replace(/\(\d+\)$/, "");
  return contentWords(knowledge, heading)
    .map((w) => w.word)
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w))
    .slice(0, 2);
}

// The most distinctive words of a chunk (rare elsewhere): options to map a visitor's word to.
function distinctiveWords(knowledge, chunk) {
  const norm = (t) => ` ${t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ")} `;
  const docs = knowledge.chunks.map((c) => norm(`${c.title} ${c.text}`));
  const seen = new Set();
  return contentWords(knowledge, `${chunk.title} ${chunk.text}`)
    .map((w) => w.word)
    .filter((w) => w.length >= 4 && !/^\d+$/.test(w) && !seen.has(w) && seen.add(w))
    .map((w, i) => ({ w, i, df: docs.filter((d) => d.includes(` ${w} `)).length }))
    .sort((a, b) => a.df - b.df || a.i - b.i)
    .slice(0, 6)
    .map((x) => x.w);
}

function diagnose(knowledge, c, ex) {
  const wanted = knowledge.chunks.filter((k) => c.expect.some((e) => matches(k.id, e)));
  if (!wanted.length) {
    return { reason: "no-such-chunk", hint: `No chunk has an id matching ${c.expect.join(" or ")}. Ids are "file#heading-slug" (see pocket-rag ask, or knowledge.json in the output folder).` };
  }
  const pos = ex.ranked.findIndex((r) => wanted.includes(r.chunk));
  const target = pos >= 0 ? ex.ranked[pos].chunk : wanted[0];
  const words = contentWords(knowledge, c.q);
  const missingEverywhere = words.filter((w) => !w.variants.some((v) => ex.terms.find((t) => t.term === v && t.df))).map((w) => w.word);
  const to = headingWords(knowledge, target);
  // Only words that appear nowhere get a synonym; a word that's elsewhere in the content would just
  // pull in the wrong sections.
  const from = missingEverywhere.filter((w) => !to.includes(w)).slice(0, 3);
  const options = distinctiveWords(knowledge, target);
  const suggestion = from.length && to.length ? { synonyms: Object.fromEntries(from.map((w) => [w, to])) } : null;
  const quoted = (list) => list.map((w) => `"${w}"`).join(", ");
  const place = pos < 0 ? "doesn't match at all" : `ranks #${pos + 1} (score ${ex.ranked[pos].score.toFixed(2)}; the cutoff is ${ex.cutoff.toFixed(2)}, the best is "${ex.ranked[0].chunk.title}" with ${ex.ranked[0].score.toFixed(2)})`;

  if (missingEverywhere.length) {
    return {
      reason: "words-not-in-content",
      target: target.id,
      ...(pos >= 0 ? { rank: pos + 1 } : {}),
      hint: `${quoted(missingEverywhere)} ${missingEverywhere.length > 1 ? "don't" : "doesn't"} appear anywhere in your content, so "${target.title}" ${place}. ${
        suggestion
          ? `Try: "synonyms": ${JSON.stringify(suggestion.synonyms)}.`
          : `Add a synonym from ${quoted(missingEverywhere.slice(0, 2))} to a word in that section that means the same (its distinctive words: ${options.join(", ")}), or a "phrases" entry.`
      } Only map words that really mean the same thing.`,
      suggestion,
      options,
    };
  }
  if (pos < 0 || ex.ranked[pos].score < ex.cutoff) {
    return {
      reason: pos < 0 ? "not-matched" : "ranked-too-low",
      target: target.id,
      ...(pos >= 0 ? { rank: pos + 1 } : {}),
      hint: `All the words are in your content, but more in other sections: "${target.title}" ${place}. Give that section a heading with the words visitors use, add a key if the question names a code, or prefer it with tuning.boost.`,
    };
  }
  return {
    reason: "budget",
    target: target.id,
    rank: pos + 1,
    hint: `"${target.title}" ranks #${pos + 1}, above the cutoff, but didn't fit: ${ex.tuning.maxChunks} chunks or ${ex.tuning.maxChars} characters were already used. Raise tuning.maxChunks / tuning.maxChars, or split long sections with more headings.`,
  };
}

export function runChecks(config, knowledge = makeKnowledge(config)) {
  const file = config.resolve(config.checks || "checks.json");
  if (!fs.existsSync(file)) return { file, missing: true, cases: [], failed: 0, total: 0 };
  const list = JSON.parse(fs.readFileSync(file, "utf8"));
  const cases = list.map((c) => {
    const ex = explain(knowledge, c.q, c.previous || "");
    const found = ex.picked.map((p) => p.id);
    const ok = c.expect.some((e) => found.some((id) => matches(id, e)));
    return { q: c.q, ...(c.previous ? { previous: c.previous } : {}), expect: c.expect, found, ok, tokens: TOKENS(ex.picked.reduce((n, p) => n + size(p), 0)), ...(ok ? {} : diagnose(knowledge, c, ex)) };
  });
  const failed = cases.filter((c) => !c.ok).length;
  const n = Math.max(1, cases.length);
  return {
    file,
    cases,
    failed,
    total: cases.length,
    avgChunks: Math.round((cases.reduce((s, c) => s + c.found.length, 0) / n) * 10) / 10,
    avgTokens: Math.round(cases.reduce((s, c) => s + c.tokens, 0) / n),
  };
}

export function formatChecks(r) {
  if (r.missing) return `No checks file (${r.file}). Add questions visitors would ask, with the chunk ids you expect: [{ "q": "…", "expect": ["file#heading"] }].`;
  const lines = [];
  for (const c of r.cases.filter((x) => !x.ok)) {
    lines.push(`MISS  ${c.q}${c.previous ? `  (after: ${c.previous})` : ""}`, `      expected: ${c.expect.join(", ")}`, `      found:    ${c.found.join(", ") || "(nothing)"}`, `      why:      ${c.hint}`);
  }
  lines.push(`${r.total - r.failed}/${r.total} found. On average ${r.avgChunks} chunks, ~${r.avgTokens} tokens of sources per question.`);
  return lines.join("\n");
}

// ------------------------------------------------------------ doctor

const OK = "ok";
const WARN = "warn";
const ERROR = "error";

function cspIn(text) {
  const found = [];
  for (const m of text.matchAll(/<meta\b[^>]*http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi)) {
    const c = m[0].match(/\bcontent="([^"]*)"/i) || m[0].match(/\bcontent='([^']*)'/i);
    if (c) found.push(c[1]);
  }
  // Header files (_headers, netlify.toml, vercel.json, …): the value after the header name.
  for (const m of text.matchAll(/Content-Security-Policy"?\s*[:=]\s*(?:"((?:[^"\\]|\\.)*)"|([^\n]+))/gi)) {
    if (/<meta/i.test(text.slice(Math.max(0, m.index - 200), m.index))) continue;
    found.push((m[1] || m[2] || "").replace(/\\"/g, '"'));
  }
  return found.filter((p) => /-src/.test(p));
}

function directive(policy, name) {
  const m = policy.match(new RegExp(`(?:^|;)\\s*${name}\\s+([^;]*)`, "i"));
  return m ? m[1].trim().split(/\s+/) : null;
}

// Does a CSP source list allow this URL (scheme + host)?
function allows(sources, url) {
  if (!sources) return true;
  const u = new URL(url);
  return sources.some((s) => {
    if (s === "*") return true;
    if (s === "https:" && u.protocol === "https:") return true;
    const clean = s.replace(/\/$/, "");
    if (clean === u.origin) return true;
    const wild = clean.match(/^https?:\/\/\*\.(.+)$/);
    return Boolean(wild && u.hostname.endsWith(`.${wild[1]}`));
  });
}

export function doctor(configPath, root = process.cwd()) {
  const results = [];
  const add = (id, status, message, fix) => results.push({ id, status, message, ...(fix ? { fix } : {}) });
  const rel = (p) => path.relative(root, p) || ".";

  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    add("config", ERROR, err.code === "ENOENT" ? `No config at ${configPath}.` : err.message, "Run `pocket-rag init` in the site's folder.");
    return { results, errors: 1, warnings: 0 };
  }
  add("config", OK, `${rel(config.resolve(path.basename(configPath)))}: "${config.name}", language ${config.lang}.`);
  const site = detect(root);

  // Content
  let knowledge;
  try {
    knowledge = makeKnowledge(config);
  } catch (err) {
    add("content", ERROR, err.message, "Fix the content files or the \"content\" paths in the config.");
  }
  if (knowledge) {
    const files = contentFiles(config);
    const chunks = knowledge.chunks;
    if (!chunks.length) add("content", ERROR, `No content found in ${[].concat(config.content || []).join(", ") || "(content not set)"}.`, `Point "content" at the folders with the site's Markdown or HTML. Candidates: ${site.candidates.slice(0, 5).map((c) => `${c.folder} (${c.files} files)`).join(", ") || "none found"}.`);
    else add("content", OK, `${files.length} files, ${chunks.length} chunks, ~${TOKENS(chunks.reduce((n, c) => n + size(c), 0))} tokens in all.`);
    const split = new Map();
    for (const c of chunks) if (/~\d+$/.test(c.id)) split.set(c.id.replace(/~\d+$/, ""), (split.get(c.id.replace(/~\d+$/, "")) || 0) + 1);
    const long = [...split].filter(([, n]) => n >= 3).map(([id]) => id);
    if (long.length) add("content-headings", WARN, `${long.length} long sections without subheadings were cut into pieces: ${long.slice(0, 5).join(", ")}${long.length > 5 ? ", …" : ""}.`, "Add ## or ### headings inside them; the search works best on one topic per section.");
    const titles = new Map();
    for (const c of chunks) titles.set(c.title, (titles.get(c.title) || 0) + 1);
    const dup = [...titles].filter(([, n]) => n > 1 && n < 50).map(([t]) => t);
    if (dup.length > 3) add("content-titles", WARN, `${dup.length} titles appear more than once, e.g. "${dup[0]}".`, "Give pages a unique # title (or <h1>), so the sources Claude sees are easy to tell apart.");
    const coreTokens = TOKENS(knowledge.core.length);
    if (coreTokens > 4000) add("core", WARN, `The core is ~${coreTokens} tokens and goes with every question.`, "Keep only the most important facts in \"core\" (1–2k tokens); everything else belongs in \"content\".");
    else add("core", OK, `Core ~${coreTokens} tokens${coreTokens < 520 ? " (too short to be cached, but cheap)" : ", cached"}.`);
  }
  if (!config.scope && !config.instructions) add("scope", WARN, "No \"scope\" in the config: the assistant will answer questions about \"the topics of this site\".", "Set \"scope\" to what it should answer about, e.g. \"our products, orders and returns\".");

  // Build output
  const out = config.resolve(config.out || "pocket-rag");
  const builtFile = path.join(out, "knowledge.json");
  if (!fs.existsSync(path.join(out, "widget.js")) || !fs.existsSync(builtFile)) add("build", ERROR, `Not built yet: ${rel(out)}/widget.js is missing.`, `Run \`pocket-rag build ${configPath}\`.`);
  else {
    let stale = false;
    try {
      const built = JSON.parse(fs.readFileSync(builtFile, "utf8"));
      const settings = JSON.parse(fs.readFileSync(path.join(out, "settings.json"), "utf8"));
      stale = (knowledge && JSON.stringify(built) !== JSON.stringify(knowledge)) || JSON.stringify(settings) !== JSON.stringify(makeSettings(config));
    } catch {
      stale = true;
    }
    const kitWidget = fs.readFileSync(new URL("../widget/widget.js", import.meta.url), "utf8");
    const older = fs.readFileSync(path.join(out, "widget.js"), "utf8") !== kitWidget;
    if (stale) add("build", WARN, "The build is out of date: the content or config changed since.", `Run \`pocket-rag build ${configPath}\` again.`);
    else if (older) add("build", WARN, "The widget in the build is from a different pocket-rag version than this one.", `Run \`pocket-rag build ${configPath}\` to update it.`);
    else add("build", OK, `Built into ${rel(out)}/ and up to date.`);
  }

  // Is the output folder published?
  const publicDir = path.resolve(root, site.publicDir);
  if (!out.startsWith(publicDir + path.sep) && out !== publicDir) {
    add("served", WARN, `${rel(out)}/ is outside ${site.publicDir === "." ? "the site folder" : `${site.publicDir}/`}, which is what a ${site.frameworkName} site publishes.`, `Set "out" to "${path.relative(config.dir, path.join(publicDir, "pocket-rag")).split(path.sep).join("/")}" and build again.`);
  } else if (site.framework === "eleventy") {
    // Eleventy only publishes what it's told to copy.
    const cfg = [".eleventy.js", "eleventy.config.js", "eleventy.config.mjs", "eleventy.config.cjs"].map((f) => path.join(root, f)).find((f) => fs.existsSync(f));
    const name = path.relative(root, out).split(path.sep).join("/");
    const copied = cfg && new RegExp(`addPassthroughCopy\\(\\s*[^)]*["'\`]\\.?\\/?${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`).test(fs.readFileSync(cfg, "utf8"));
    if (copied) add("served", OK, `${name}/ is copied into the site (addPassthroughCopy).`);
    else add("served", ERROR, `Eleventy doesn't copy ${name}/ into the built site yet.`, `Add \`eleventyConfig.addPassthroughCopy("${name}");\` to ${cfg ? path.basename(cfg) : "the Eleventy config"}.`);
  } else add("served", OK, `${rel(out)}/ is inside the published folder (${site.frameworkName}).`);

  // Script tag and CSP
  const skip = [out, config.worker ? config.resolve(config.worker) : null].filter(Boolean);
  const files = sourceFiles(root, skip);
  const tags = [];
  const policies = [];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    if (text.includes("widget.js") && /pocket-rag/.test(text)) {
      const line = text.split("\n").find((l) => l.includes("widget.js")) || "";
      tags.push({ file: rel(f), module: /module/.test(line) });
    }
    for (const p of cspIn(text)) policies.push({ file: rel(f), policy: p });
  }
  if (!tags.length) add("script", ERROR, "No page loads pocket-rag/widget.js yet.", site.script);
  else if (tags.some((t) => !t.module)) add("script", ERROR, `The script tag in ${tags.filter((t) => !t.module).map((t) => t.file).join(", ")} isn't type="module".`, 'Use <script type="module" src=".../pocket-rag/widget.js">.');
  else add("script", OK, `Loaded in ${tags.map((t) => t.file).join(", ")}.`);

  const needed = config.proxyUrl ? config.proxyUrl : "https://api.anthropic.com";
  if (!policies.length) add("csp", OK, "No Content-Security-Policy found; nothing to change.");
  for (const { file, policy } of policies) {
    const connect = directive(policy, "connect-src") || directive(policy, "default-src");
    const script = directive(policy, "script-src") || directive(policy, "default-src");
    const problems = [];
    if (!allows(connect, needed)) problems.push(`connect-src must allow ${new URL(needed).origin}`);
    if (script && !script.includes("'self'") && !script.includes("*")) problems.push("script-src must allow 'self'");
    const style = directive(policy, "style-src") || directive(policy, "default-src");
    if (style && !style.includes("'self'") && !style.includes("*")) problems.push("style-src must allow 'self'");
    if (problems.length) add("csp", ERROR, `The Content-Security-Policy in ${file} blocks the assistant: ${problems.join("; ")}.`, `Add ${new URL(needed).origin} to connect-src${problems.length > 1 ? " and 'self' where listed" : ""}.`);
    else add("csp", OK, `The Content-Security-Policy in ${file} allows the assistant.`);
  }

  // Proxy
  if (config.proxyUrl) {
    if (!/^https:\/\//.test(config.proxyUrl)) add("proxy", ERROR, `proxyUrl must start with https:// (${config.proxyUrl}).`, "Use the address `wrangler deploy` printed.");
    const toml = config.worker ? path.join(config.resolve(config.worker), "wrangler.toml") : null;
    const origins = toml && fs.existsSync(toml) ? (fs.readFileSync(toml, "utf8").match(/ALLOWED_ORIGINS\s*=\s*"([^"]*)"/) || [])[1] : null;
    if (origins !== null && origins !== undefined && /localhost/.test(origins) && !/https:/.test(origins)) add("proxy", WARN, "ALLOWED_ORIGINS in wrangler.toml only allows localhost.", "Add the site's address, e.g. \"https://you.github.io\", and run `npx wrangler deploy` again.");
    else add("proxy", OK, `Proxy at ${config.proxyUrl}.`);
  } else add("mode", OK, "No proxy: visitors enter their own Anthropic API key, which stays in their browser.");

  // Privacy
  const privacy = config.ui && config.ui.privacyUrl;
  if (!privacy) add("privacy", WARN, "No privacy link in the chat (ui.privacyUrl).", "Questions go to Anthropic, so tell visitors. Add a privacy page or section (a starting point: https://github.com/sir-Disappointing/pocket-rag/blob/main/example/site/privacy.html) and set ui.privacyUrl to it.");
  else if (/^(https?:)?\/\//.test(privacy) || privacy.includes("#")) add("privacy", OK, `Privacy link: ${privacy}.`);
  else {
    const p = privacy.replace(/^\.?\//, "").replace(/\/$/, "");
    const base = p.replace(/\.html?$/, "");
    const candidates = [p, `${base}.html`, `${base}/index.html`, `${base}.md`, `${base}/index.md`, `content/${base}.md`, `src/pages/${base}.astro`, `src/pages/${base}.md`, `docs/${base}.md`];
    const found = [publicDir, root].some((d) => candidates.some((c) => fs.existsSync(path.join(d, c))));
    if (found) add("privacy", OK, `Privacy link: ${privacy}.`);
    else add("privacy", WARN, `ui.privacyUrl is "${privacy}", but no such page was found.`, "Create that page, or point ui.privacyUrl at the existing privacy page.");
  }

  // Secrets
  const leaks = [];
  for (const f of files) {
    if (/sk-ant-[a-zA-Z0-9_-]{20,}/.test(fs.readFileSync(f, "utf8"))) leaks.push(rel(f));
  }
  if (leaks.length) add("secrets", ERROR, `Something that looks like an Anthropic API key is in ${leaks.join(", ")}.`, "Remove it now and delete that key in the Anthropic Console: anything in the site is public. Keys belong in the visitor's browser or in the Worker secret (`npx wrangler secret put ANTHROPIC_API_KEY`).");
  else add("secrets", OK, "No API keys in the site's files.");

  // Language
  if (!site.langSupported && site.langFound !== config.lang) add("lang", WARN, `The site looks like it's in "${site.langFound}", which pocket-rag has no word list for; using "${config.lang}".`, "Answers will still be in the visitor's language, but the search ignores fewer filler words. See \"Adding a language\" in the README.");

  // Checks
  if (knowledge) {
    const r = runChecks(config, knowledge);
    if (r.missing) add("checks", WARN, "No checks.json: the search hasn't been tested.", "Write 15–30 questions in a visitor's words with the chunk ids you expect, then run `pocket-rag check`.");
    else if (r.total < 10) add("checks", WARN, r.total ? `Only ${r.total} checks.` : "No checks yet: the search hasn't been tested.", "Add questions worded the way visitors would ask them (15–30 is a good number) to checks.json, then run `pocket-rag check`.");
    if (!r.missing && r.failed) add("checks", ERROR, `${r.failed} of ${r.total} checks miss.`, "Run `pocket-rag check` to see why and what to add.");
    else if (!r.missing && r.total >= 10) add("checks", OK, `${r.total}/${r.total} checks pass, ~${r.avgTokens} tokens of sources per question.`);
  }

  return { site: { framework: site.frameworkName, publicDir: site.publicDir }, results, errors: results.filter((r) => r.status === ERROR).length, warnings: results.filter((r) => r.status === WARN).length };
}

export function formatDoctor(r) {
  const icon = { ok: "✔", warn: "!", error: "✖" };
  const lines = r.results.map((x) => `${icon[x.status]} ${x.message}${x.fix && x.status !== OK ? `\n    → ${x.fix}` : ""}`);
  lines.push("", r.errors ? `${r.errors} problem(s) to fix${r.warnings ? `, ${r.warnings} warning(s)` : ""}.` : r.warnings ? `Works. ${r.warnings} warning(s) worth a look.` : "All good.");
  return lines.join("\n");
}

