// Turns a folder of content into a knowledge base plus the files the widget and Worker need.
//
//   core:   always sent (cached): the instructions plus your core files.
//   chunks: searched per question; only the best matches are sent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LANGS } from "./retrieve.mjs";

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

// Sections ({ heading, anchor, text, keys }) to chunks with stable ids: "file#heading-slug".
function sectionChunks(sections, docTitle, rel) {
  const base = rel.replace(/\.[^.]+$/, "");
  const chunks = [];
  const seen = new Map();
  for (const s of sections) {
    if (!s.text) continue;
    const title = s.heading ? `${docTitle} › ${s.heading}` : docTitle;
    let id = s.heading ? `${base}#${s.anchor || slug(s.heading)}` : base;
    const n = (seen.get(id) || 0) + 1;
    seen.set(id, n);
    if (n > 1) id += `-${n}`;
    const parts = split(s.text);
    parts.forEach((t, i) =>
      chunks.push({
        id: parts.length > 1 ? `${id}~${i + 1}` : id,
        title: parts.length > 1 ? `${title} (${i + 1})` : title,
        text: t,
        ...(s.keys.length ? { keys: s.keys } : {}),
      })
    );
  }
  return chunks;
}

export function chunkMarkdown(md, rel) {
  const lines = md.replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "").split("\n");
  const h1 = lines.find((l) => /^#\s+/.test(l));
  const docTitle = h1 ? plain(h1.replace(/^#\s+/, "").replace(/\s*\{#[^}]+\}\s*$/, "")) : humanize(rel);
  const raw = [];
  let cur = { heading: null, anchor: null, lines: [] };
  for (const line of lines) {
    if (/^#\s+/.test(line)) continue;
    const m = line.match(/^#{2,6}\s+(.+?)\s*#*$/);
    if (m) {
      raw.push(cur);
      // "## Heading {#custom-id}" (Hugo, Jekyll, VitePress) keeps its own anchor.
      const anchor = m[1].match(/\s*\{#([^}]+)\}$/);
      cur = { heading: plain(m[1].replace(/\s*\{#[^}]+\}$/, "")), anchor: anchor && anchor[1], lines: [] };
    } else cur.lines.push(line);
  }
  raw.push(cur);
  const sections = raw.map((r) => ({ heading: r.heading, anchor: r.anchor, text: plain(r.lines.join("\n")), keys: keysFrom(r.lines.join("\n")) }));
  return sectionChunks(sections, docTitle, rel);
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

// Folders that are never content: dependencies, build output, and what pocket-rag writes itself.
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "_site", "out", ".next", ".astro", ".vitepress", "coverage", "vendor"]);

function walk(p, skip) {
  const stat = fs.statSync(p);
  if (stat.isFile()) return [p];
  return fs
    .readdirSync(p)
    .filter((f) => !f.startsWith("."))
    .sort()
    .map((f) => path.join(p, f))
    .filter((f) => !skip(f))
    .flatMap((f) => walk(f, skip));
}

// HTML pages: the main text, split at <h2> and <h3>. Navigation, header, footer and scripts are left out.
export function htmlToText(html) {
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", euro: "€", copy: "©" };
  return html
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "")
    .replace(/<\/(tr|dt|dd)>/gi, "\n")
    .replace(/<\/(p|div|section|article|ul|ol|table|blockquote|pre|h[1-6]|figure)>/gi, "\n\n")
    .replace(/<(td|th)\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) =>
      e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : entities[e.toLowerCase()] ?? m
    )
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n(- \n)+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function chunkHtml(html, rel) {
  let doc = html.replace(/\r\n/g, "\n");
  // Keys comments are read per section below, other comments go.
  doc = doc.replace(/<!--(?!\s*keys:)[\s\S]*?-->/g, "");
  for (const tag of ["script", "style", "noscript", "template", "svg", "nav", "header", "footer", "aside", "form", "button"]) {
    doc = doc.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, "gi"), "");
  }
  const pageTitle = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const main = doc.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i) || doc.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i) || doc.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  let body = main ? main[1] : doc;
  const h1 = body.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const docTitle = (h1 && htmlToText(h1[1])) || (pageTitle && htmlToText(pageTitle)) || humanize(rel);
  if (h1) body = body.replace(h1[0], "");

  const sections = [];
  const re = /<h([23])\b([^>]*)>([\s\S]*?)<\/h\1>/gi;
  let last = 0;
  let cur = { heading: null, anchor: null };
  const close = (end) => {
    const part = body.slice(last, end);
    sections.push({ ...cur, text: htmlToText(part.replace(/<!--[\s\S]*?-->/g, "")), keys: keysFrom(part) });
  };
  for (const m of body.matchAll(re)) {
    close(m.index);
    cur = { heading: htmlToText(m[3]), anchor: (m[2].match(/\bid=["']([^"']+)["']/) || [])[1] || null };
    last = m.index + m[0].length;
  }
  close(body.length);
  return sectionChunks(sections, docTitle, rel);
}

// MDX: drop imports, exports and components, keep the Markdown.
export function mdxToMarkdown(src) {
  return src
    .replace(/^(import|export)\s.*$/gm, "")
    .replace(/<([A-Z][\w.]*)\b[^>]*\/>/g, "")
    .replace(/<\/?[A-Z][\w.]*\b[^>]*>/g, "")
    .replace(/^\s*\{\/\*[\s\S]*?\*\/\}\s*$/gm, "");
}

// Only JSON shaped like content counts; package.json and friends are skipped quietly.
const isChunkJson = (data) => {
  const list = Array.isArray(data) ? data : data && data.chunks;
  return Array.isArray(list) && list.length > 0 && list.every((c) => c && typeof c === "object" && "title" in c && "text" in c);
};

export function contentFiles(config) {
  const own = [config.out || "pocket-rag", config.worker].filter(Boolean).map((p) => config.resolve(p));
  const excluded = [].concat(config.exclude || []).map((p) => config.resolve(p));
  const skip = (f) => SKIP_DIRS.has(path.basename(f)) || own.includes(f) || excluded.includes(f);
  const files = [];
  for (const entry of [].concat(config.content || [])) {
    const root = config.resolve(entry);
    if (!fs.existsSync(root)) throw new Error(`content: "${entry}" doesn't exist (relative to ${path.relative(process.cwd(), config.dir) || "."})`);
    const rootDir = fs.statSync(root).isFile() ? path.dirname(root) : root;
    for (const file of walk(root, skip)) {
      const name = path.basename(file);
      if (name === "pocket-rag.config.json" || file === config.resolve(config.checks || "checks.json")) continue;
      const ext = path.extname(file).toLowerCase();
      if (![".md", ".markdown", ".mdx", ".txt", ".json", ".html", ".htm"].includes(ext)) continue;
      files.push({ file, rel: path.relative(rootDir, file).split(path.sep).join("/"), ext, explicit: file === root });
    }
  }
  return files;
}

export function readContent(config) {
  const chunks = [];
  for (const { file, rel, ext, explicit } of contentFiles(config)) {
    const src = fs.readFileSync(file, "utf8");
    if (ext === ".md" || ext === ".markdown") chunks.push(...chunkMarkdown(src, rel));
    else if (ext === ".mdx") chunks.push(...chunkMarkdown(mdxToMarkdown(src), rel));
    else if (ext === ".txt") chunks.push(...chunkText(src, rel));
    else if (ext === ".html" || ext === ".htm") chunks.push(...chunkHtml(src, rel));
    else if (ext === ".json") {
      let data;
      try {
        data = JSON.parse(src);
      } catch (err) {
        if (explicit) throw new Error(`${rel}: ${err.message}`);
        continue;
      }
      if (explicit || isChunkJson(data)) chunks.push(...chunkJson(data, rel));
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
    ...(config.stopwords ? { stopwords: config.stopwords } : {}),
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
    storageKey: config.storageKey || `pocket-rag:${slug(config.name)}:key`,
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
  // Before 0.3 these were .mjs; remove the old copies when upgrading.
  for (const f of RUNTIME) fs.rmSync(path.join(out, f), { force: true });
  // In the browser the search code is served as .js: not every web server knows the .mjs type.
  for (const f of RUNTIME) {
    const to = path.join(out, f.replace(/\.mjs$/, ".js"));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, fs.readFileSync(path.join(KIT, "src", f), "utf8").replace(/(from "\.\/lang\/\w+)\.mjs"/g, '$1.js"'));
  }
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
