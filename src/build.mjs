// Turns a folder of content into a knowledge base plus the files the widget and Worker need.
//
//   core:   always sent (cached): the instructions plus your core files.
//   chunks: searched per question; only the best matches are sent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LANGS, retrieve } from "./retrieve.mjs";

const KIT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAX_CHUNK = 1500;

export const DEFAULT_SETTINGS = {
  model: "claude-haiku-5-5",
  maxTokens: 800,
  effort: "low",
  maxHistory: 12,
  maxQuestion: 2000,
};

export function loadConfig(configPath, overrides = {}) {
  const file = path.resolve(configPath);
  const config = { ...JSON.parse(fs.readFileSync(file, "utf8")), ...overrides };
  const dir = path.dirname(file);
  if (!config.name) throw new Error(`${configPath}: "name" is required`);
  if (config.lang && !LANGS[config.lang]) throw new Error(`${configPath}: unknown lang "${config.lang}" (have: ${Object.keys(LANGS).join(", ")})`);
  return { ...config, lang: config.lang || "en", dir, resolve: (p) => path.resolve(dir, p) };
}

// ------------------------------------------------------------ content

const slug = (s) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "section";

const humanize = (file) => {
  const base = path.basename(file, path.extname(file)).replace(/[-_]+/g, " ").trim();
  return base.charAt(0).toUpperCase() + base.slice(1);
};

// Plain text from Markdown: links keep their text, formatting goes, lists stay readable.
export function plain(md) {
  return md
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[*+]\s+/gm, "- ")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?=[^*\w]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^```.*$/gm, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Long sections are split at paragraph boundaries.
function split(text, max = MAX_CHUNK) {
  if (text.length <= max) return [text];
  const parts = [];
  let cur = "";
  for (const para of text.split(/\n{2,}/)) {
    if (cur && cur.length + para.length + 2 > max) {
      parts.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n\n${para}` : para;
  }
  if (cur) parts.push(cur);
  return parts;
}

function keysFrom(md) {
  const keys = [];
  for (const m of md.matchAll(/<!--\s*keys:\s*([^>]*?)\s*-->/gi)) keys.push(...m[1].split(",").map((k) => k.trim()).filter(Boolean));
  return keys;
}

export function chunkMarkdown(md, rel) {
  const lines = md.replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "").split("\n");
  const h1 = lines.find((l) => /^#\s+/.test(l));
  const docTitle = h1 ? h1.replace(/^#\s+/, "").trim() : humanize(rel);
  const sections = [];
  let cur = { heading: null, lines: [] };
  for (const line of lines) {
    if (/^#\s+/.test(line)) continue;
    const m = line.match(/^#{2,6}\s+(.+?)\s*#*$/);
    if (m) {
      sections.push(cur);
      cur = { heading: m[1].trim(), lines: [] };
    } else cur.lines.push(line);
  }
  sections.push(cur);

  const base = rel.replace(/\.[^.]+$/, "");
  const chunks = [];
  const seen = new Map();
  for (const s of sections) {
    const raw = s.lines.join("\n");
    const text = plain(raw);
    if (!text) continue;
    const title = s.heading ? `${docTitle} › ${plain(s.heading)}` : docTitle;
    let id = s.heading ? `${base}#${slug(s.heading)}` : base;
    const n = (seen.get(id) || 0) + 1;
    seen.set(id, n);
    if (n > 1) id += `-${n}`;
    const keys = keysFrom(raw);
    const parts = split(text);
    parts.forEach((t, i) =>
      chunks.push({
        id: parts.length > 1 ? `${id}~${i + 1}` : id,
        title: parts.length > 1 ? `${title} (${i + 1})` : title,
        text: t,
        ...(keys.length ? { keys } : {}),
      })
    );
  }
  return chunks;
}

export function chunkText(txt, rel) {
  const title = humanize(rel);
  const parts = split(txt.replace(/\r\n/g, "\n").trim());
  const base = rel.replace(/\.[^.]+$/, "");
  return parts.map((t, i) => ({ id: parts.length > 1 ? `${base}~${i + 1}` : base, title: parts.length > 1 ? `${title} (${i + 1})` : title, text: t }));
}

export function chunkJson(data, rel) {
  const list = Array.isArray(data) ? data : data.chunks;
  if (!Array.isArray(list)) throw new Error(`${rel}: expected an array of { title, text } or { "chunks": [...] }`);
  const base = rel.replace(/\.[^.]+$/, "");
  return list.map((c, i) => {
    if (!c || typeof c.title !== "string" || typeof c.text !== "string") throw new Error(`${rel}[${i}]: needs "title" and "text" strings`);
    return { id: c.id ? String(c.id) : `${base}#${i + 1}`, title: c.title.trim(), text: c.text.trim(), ...(c.keys ? { keys: c.keys.map(String) } : {}) };
  });
}

function walk(p) {
  const stat = fs.statSync(p);
  if (stat.isFile()) return [p];
  return fs
    .readdirSync(p)
    .filter((f) => !f.startsWith("."))
    .sort()
    .flatMap((f) => walk(path.join(p, f)));
}

export function readContent(config) {
  const chunks = [];
  for (const entry of [].concat(config.content || [])) {
    const root = config.resolve(entry);
    const rootDir = fs.statSync(root).isFile() ? path.dirname(root) : root;
    for (const file of walk(root)) {
      const rel = path.relative(rootDir, file).split(path.sep).join("/");
      const ext = path.extname(file).toLowerCase();
      const src = fs.readFileSync(file, "utf8");
      if (ext === ".md" || ext === ".markdown") chunks.push(...chunkMarkdown(src, rel));
      else if (ext === ".txt") chunks.push(...chunkText(src, rel));
      else if (ext === ".json") chunks.push(...chunkJson(JSON.parse(src), rel));
    }
  }
  const ids = new Set();
  for (const c of chunks) {
    if (ids.has(c.id)) throw new Error(`Duplicate chunk id "${c.id}". Give JSON chunks unique ids or rename a heading.`);
    ids.add(c.id);
  }
  return chunks;
}

export function makeCore(config) {
  const L = LANGS[config.lang];
  let instructions;
  if (config.instructions) {
    const p = config.resolve(config.instructions);
    instructions = fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : config.instructions;
  } else instructions = L.instructions({ name: config.name, about: config.about, scope: config.scope });
  const core = [].concat(config.core || []).map((f) => fs.readFileSync(config.resolve(f), "utf8").trim());
  return [instructions, ...core].join("\n\n");
}

export function makeKnowledge(config) {
  return {
    lang: config.lang,
    core: makeCore(config),
    chunks: readContent(config),
    ...(config.synonyms ? { synonyms: config.synonyms } : {}),
    ...(config.phrases ? { phrases: config.phrases } : {}),
    ...(config.tuning ? { tuning: config.tuning } : {}),
  };
}

// What the widget needs before it opens: texts, mode and limits. No secrets in here.
export function makeSettings(config) {
  const strings = { ...LANGS[config.lang].strings, ...(config.ui || {}) };
  delete strings.suggestions;
  delete strings.privacyUrl;
  return {
    name: config.name,
    lang: config.lang,
    proxyUrl: config.proxyUrl || "",
    ...DEFAULT_SETTINGS,
    ...pick(config, Object.keys(DEFAULT_SETTINGS)),
    storageKey: `pocket-rag:${slug(config.name)}:key`,
    suggestions: (config.ui && config.ui.suggestions) || [],
    privacyUrl: (config.ui && config.ui.privacyUrl) || "",
    strings,
  };
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

// ------------------------------------------------------------ writing

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

const RUNTIME = ["retrieve.mjs", "lang/en.mjs", "lang/nl.mjs"];
const HEADER = "// Generated by pocket-rag build. Don't edit by hand.\n";

export function build(configPath, log = console.log, overrides = {}) {
  const config = loadConfig(configPath, overrides);
  const knowledge = makeKnowledge(config);
  const settings = makeSettings(config);
  if (!knowledge.chunks.length) log("Warning: no content found. Check \"content\" in the config.");

  const out = config.resolve(config.out || "pocket-rag");
  fs.mkdirSync(out, { recursive: true });
  for (const f of RUNTIME) copy(path.join(KIT, "src", f), path.join(out, f));
  copy(path.join(KIT, "widget", "widget.js"), path.join(out, "widget.js"));
  copy(path.join(KIT, "widget", "widget.css"), path.join(out, "widget.css"));
  fs.writeFileSync(path.join(out, "knowledge.json"), JSON.stringify(knowledge));
  fs.writeFileSync(path.join(out, "settings.json"), JSON.stringify(settings, null, 2) + "\n");

  if (config.worker) {
    const w = config.resolve(config.worker);
    for (const f of RUNTIME) copy(path.join(KIT, "src", f), path.join(w, "src", f));
    fs.writeFileSync(path.join(w, "src", "knowledge.js"), `${HEADER}export default ${JSON.stringify(knowledge)};\n`);
    const { proxyUrl, storageKey, suggestions, privacyUrl, ...workerSettings } = settings;
    fs.writeFileSync(path.join(w, "src", "settings.js"), `${HEADER}export default ${JSON.stringify(workerSettings, null, 2)};\n`);
    // The Worker code and its config are yours once created; only the data is regenerated.
    for (const f of ["src/index.js", "wrangler.toml", "package.json"]) {
      if (!fs.existsSync(path.join(w, f))) copy(path.join(KIT, "worker", f), path.join(w, f));
    }
  }

  const tokens = (chars) => Math.round(chars / 3.8);
  const total = knowledge.chunks.reduce((n, c) => n + c.title.length + c.text.length, 0);
  log(`${config.name}: core ~${tokens(knowledge.core.length)} tokens, ${knowledge.chunks.length} chunks (~${tokens(total)} tokens in all).`);
  const rel = (p) => path.relative(process.cwd(), p) || ".";
  log(`Wrote ${rel(out)}/${config.worker ? ` and ${rel(config.resolve(config.worker))}/src/` : ""}`);
  // Prompt caching needs a minimum prefix length (512 tokens for Claude Haiku 5.5).
  if (tokens(knowledge.core.length) < 600) log("Note: the core is short, so it may be below the minimum for prompt caching. That's fine: a short core is cheap anyway.");
  return { config, knowledge, settings };
}

// ------------------------------------------------------------ checking

// checks.json: [{ "q": "question", "expect": ["chunk-id", "id-prefix#"], "previous": "optional earlier question" }]
export function check(configPath, log = console.log, overrides = {}) {
  const config = loadConfig(configPath, overrides);
  if (!config.checks) throw new Error(`${configPath}: add "checks": "checks.json" to test the search`);
  const knowledge = makeKnowledge(config);
  const cases = JSON.parse(fs.readFileSync(config.resolve(config.checks), "utf8"));
  let failed = 0;
  let chars = 0;
  let pieces = 0;
  for (const c of cases) {
    const got = retrieve(knowledge, c.q, c.previous || "");
    const ids = got.map((g) => g.id);
    chars += got.reduce((n, g) => n + g.title.length + g.text.length, 0);
    pieces += got.length;
    if (!c.expect.some((e) => ids.some((id) => id === e || id.startsWith(e)))) {
      failed++;
      log(`MISS  ${c.q}\n      expected one of: ${c.expect.join(", ")}\n      found: ${ids.join(", ") || "(nothing)"}`);
    }
  }
  const per = cases.length ? Math.round(chars / cases.length / 3.8) : 0;
  log(`${cases.length - failed}/${cases.length} found. On average ${(pieces / Math.max(1, cases.length)).toFixed(1)} chunks, ~${per} tokens of sources per question.`);
  return { failed, total: cases.length };
}
