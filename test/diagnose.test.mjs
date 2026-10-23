import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, loadConfig, makeKnowledge } from "../src/build.mjs";
import { detect } from "../src/detect.mjs";
import { ask, runChecks, doctor } from "../src/diagnose.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXAMPLE = path.join(ROOT, "example", "pocket-rag.config.json");
const quiet = () => {};

// A small site on disk: { "path": "content" }.
function site(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pocket-rag-site-"));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), typeof text === "string" ? text : JSON.stringify(text, null, 1));
  }
  return dir;
}

const PAGE = (body, head = "") => `<!doctype html><html lang="en"><head><title>Crumb | Bakery</title>${head}</head><body><header><nav>Menu</nav></header><main>${body}</main></body></html>`;

test("detect: plain static site", () => {
  const d = detect(site({ "index.html": PAGE("<h1>Crumb</h1><p>Bread.</p>"), "about.html": PAGE("<p>Us</p>") }));
  assert.equal(d.framework, "static");
  assert.equal(d.publicDir, ".");
  assert.equal(d.out, "pocket-rag");
  assert.deepEqual(d.content, ["."]);
  assert.equal(d.name, "Crumb");
  assert.equal(d.lang, "en");
});

test("detect: Hugo, with language, name and content, ignoring layouts", () => {
  const d = detect(site({ "hugo.toml": 'languageCode = "nl-nl"\ntitle = "Fietsclub"\n', "content/a.md": "# A", "content/b/c.md": "# C", "layouts/_default/baseof.html": "<html></html>" }));
  assert.equal(d.framework, "hugo");
  assert.equal(d.out, "static/pocket-rag");
  assert.deepEqual(d.content, ["content"]);
  assert.equal(d.lang, "nl");
  assert.equal(d.name, "Fietsclub");
  assert.match(d.script, /baseof\.html/);
});

test("detect: Astro prefers src/pages, name from the layout", () => {
  const d = detect(site({ "astro.config.mjs": "", "src/pages/a.md": "# A", "src/layouts/Base.astro": "<title>Demo Docs</title>", "public/x.txt": "" }));
  assert.equal(d.framework, "astro");
  assert.equal(d.out, "public/pocket-rag");
  assert.deepEqual(d.content, ["src/pages"]);
  assert.equal(d.name, "Demo Docs");
  assert.match(d.script, /is:inline/);
});

test("detect: unsupported language falls back to English and says so", () => {
  const d = detect(site({ "index.html": '<html lang="de"><title>Bäckerei</title></html>' }));
  assert.equal(d.lang, "en");
  assert.equal(d.langFound, "de");
  assert.equal(d.langSupported, false);
});

test("content: HTML pages, skipping package.json, node_modules and the output", () => {
  const dir = site({
    "index.html": PAGE("<h1>Crumb</h1><p>Sourdough since 2009.</p><h2 id='allergy'>Allergies</h2><p>Nuts and wheat.</p>"),
    "package.json": { name: "x" },
    "node_modules/pkg/readme.md": "# Should not appear",
    "pocket-rag.config.json": { name: "Crumb", content: ["."], out: "pocket-rag" },
  });
  const { knowledge } = build(path.join(dir, "pocket-rag.config.json"), quiet);
  assert.deepEqual(knowledge.chunks.map((c) => c.id), ["index", "index#allergy"]);
  // A second build must not pick up its own output.
  const again = build(path.join(dir, "pocket-rag.config.json"), quiet).knowledge;
  assert.equal(again.chunks.length, 2);
});

test("ask explains terms, words missing from the content, and what is sent", () => {
  const knowledge = makeKnowledge(loadConfig(EXAMPLE, { synonyms: {} }));
  const r = ask(knowledge, "How does the horse move?");
  assert.deepEqual(r.notInContent, ["horse"]);
  assert.ok(r.terms.find((t) => t.term === "horse" && t.df === 0));
  assert.ok(r.ranked.length && r.ranked[0].matched.length);
  assert.equal(r.sent.length, r.ranked.filter((x) => x.sent).length);
  // With the example's synonyms, "horse" is no longer reported.
  assert.deepEqual(ask(makeKnowledge(loadConfig(EXAMPLE)), "How does the horse move?").notInContent, []);
});

test("check explains misses and suggests synonyms only for words that are nowhere", () => {
  const dir = site({
    "content/pieces.md": "# Pieces\n\n## Knight\nThe knight jumps in an L shape.\n\n## Rook\nThe rook moves in straight lines, also sideways.\n",
    "checks.json": [
      { q: "How does the horse move?", expect: ["pieces#knight"] },
      { q: "What does the rook do?", expect: ["pieces#rook"] },
      { q: "Anything", expect: ["missing#id"] },
    ],
    "pocket-rag.config.json": { name: "Chess", content: ["content"], checks: "checks.json" },
  });
  const r = runChecks(loadConfig(path.join(dir, "pocket-rag.config.json")));
  assert.equal(r.total, 3);
  assert.equal(r.failed, 2);
  const horse = r.cases.find((c) => c.q.includes("horse"));
  assert.equal(horse.reason, "words-not-in-content");
  assert.deepEqual(horse.suggestion, { synonyms: { horse: ["knight"] } });
  assert.ok(r.cases.find((c) => c.q === "What does the rook do?").ok);
  assert.equal(r.cases.find((c) => c.q === "Anything").reason, "no-such-chunk");
});

test("doctor: a fresh site lists what to do, with fixes", () => {
  const dir = site({
    "index.html": PAGE("<h1>Crumb</h1><p>Bread.</p>", `<meta http-equiv="Content-Security-Policy" content="default-src 'self'">`),
    "pocket-rag.config.json": { name: "Crumb", content: ["."], out: "pocket-rag", checks: "checks.json" },
  });
  const r = doctor(path.join(dir, "pocket-rag.config.json"), dir);
  const by = (id) => r.results.filter((x) => x.id === id);
  assert.equal(by("build")[0].status, "error");
  assert.equal(by("script")[0].status, "error");
  assert.match(by("script")[0].fix, /type="module"/);
  assert.equal(by("csp")[0].status, "error");
  assert.match(by("csp")[0].message, /connect-src must allow https:\/\/api\.anthropic\.com/);
  assert.equal(by("privacy")[0].status, "warn");
  assert.equal(by("scope")[0].status, "warn");
  assert.equal(by("checks")[0].status, "warn");
  assert.ok(r.errors >= 3);
});

test("doctor: a finished site is all green", () => {
  const checks = Array.from({ length: 10 }, () => ({ q: "Do you sell sourdough bread?", expect: ["index"] }));
  const dir = site({
    "index.html": PAGE(
      '<h1>Crumb</h1><p>We sell sourdough bread.</p><script type="module" src="pocket-rag/widget.js"></script>',
      `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' https://api.anthropic.com">`
    ),
    "privacy.html": PAGE("<p>Privacy</p>"),
    "checks.json": checks,
    "pocket-rag.config.json": { name: "Crumb", scope: "our bakery", content: ["index.html"], out: "pocket-rag", checks: "checks.json", ui: { privacyUrl: "privacy.html" } },
  });
  build(path.join(dir, "pocket-rag.config.json"), quiet);
  const r = doctor(path.join(dir, "pocket-rag.config.json"), dir);
  assert.deepEqual(r.results.filter((x) => x.status !== "ok"), []);
  assert.equal(r.errors, 0);
});

test("doctor: finds an API key in the site and a CSP that blocks the proxy", () => {
  const dir = site({
    "index.html": PAGE('<script type="module" src="pocket-rag/widget.js"></script>', `<meta http-equiv="Content-Security-Policy" content="connect-src 'self' https://api.anthropic.com">`),
    "config.js": 'const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";',
    "pocket-rag.config.json": { name: "X", content: ["index.html"], out: "pocket-rag", proxyUrl: "https://proxy.example.workers.dev" },
  });
  const r = doctor(path.join(dir, "pocket-rag.config.json"), dir);
  assert.equal(r.results.find((x) => x.id === "secrets").status, "error");
  assert.match(r.results.find((x) => x.id === "csp").message, /proxy\.example\.workers\.dev/);
});
