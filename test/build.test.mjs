import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, check, chunkMarkdown, chunkJson, chunkText, plain, makeSettings, loadConfig } from "../src/build.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXAMPLE = path.join(ROOT, "example", "pocket-rag.config.json");
const quiet = () => {};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pocket-rag-"));

test("plain() keeps text and drops Markdown syntax", () => {
  assert.equal(plain("A [link](http://x) and **bold** and `code` <!-- note -->"), "A link and bold and code");
  assert.equal(plain("* one\n+ two"), "- one\n- two");
  assert.equal(plain("![img](a.png)Text"), "Text");
});

test("chunkMarkdown: one chunk per heading, with ids, titles and keys", () => {
  const md = "# Guide\n\nIntro text.\n\n## Parking rules\n<!-- keys: P1, P 2 -->\nNo parking here.\n\n### Parking rules\nAgain.\n\n## Empty\n";
  const chunks = chunkMarkdown(md, "road/guide.md");
  assert.deepEqual(
    chunks.map((c) => [c.id, c.title]),
    [
      ["road/guide", "Guide"],
      ["road/guide#parking-rules", "Guide › Parking rules"],
      ["road/guide#parking-rules-2", "Guide › Parking rules"],
    ]
  );
  assert.deepEqual(chunks[1].keys, ["P1", "P 2"]);
  assert.equal(chunks[1].text, "No parking here.");
});

test("chunkMarkdown: title from the file name without an h1, front matter ignored", () => {
  const [c] = chunkMarkdown("---\ntitle: x\n---\nJust text.", "house-rules.md");
  assert.equal(c.title, "House rules");
  assert.equal(c.text, "Just text.");
});

test("long sections are split at paragraphs", () => {
  const para = "word ".repeat(200).trim();
  const chunks = chunkMarkdown(`# T\n\n## Long\n${[para, para, para].join("\n\n")}`, "t.md");
  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0].id, "t#long~1");
  assert.equal(chunks[0].title, "T › Long (1)");
});

test("chunkJson validates and keeps ids and keys", () => {
  assert.deepEqual(chunkJson([{ title: "A", text: "x", keys: [6] }], "faq.json"), [{ id: "faq#1", title: "A", text: "x", keys: ["6"] }]);
  assert.deepEqual(chunkJson({ chunks: [{ id: "q", title: "B", text: "y" }] }, "f.json")[0].id, "q");
  assert.throws(() => chunkJson([{ title: "A" }], "bad.json"), /bad.json\[0\]/);
  assert.throws(() => chunkJson({}, "bad.json"), /expected an array/);
});

test("chunkText uses the file name as title", () => {
  assert.deepEqual(chunkText("Hello there.", "opening-hours.txt"), [{ id: "opening-hours", title: "Opening hours", text: "Hello there." }]);
});

test("settings contain texts and limits but no secrets", () => {
  const s = makeSettings(loadConfig(EXAMPLE));
  assert.equal(s.model, "claude-haiku-5-5");
  assert.equal(s.maxTokens, 800);
  assert.equal(s.storageKey, "pocket-rag:chess-rules-explained:key");
  assert.equal(s.strings.welcome, "Hi! Ask me anything about the rules of chess.");
  assert.equal(s.strings.send, "Send");
  assert.equal(s.suggestions.length, 3);
  assert.ok(!("suggestions" in s.strings));
  assert.ok(!/sk-ant/.test(JSON.stringify(s)));
  assert.equal(makeSettings(loadConfig(EXAMPLE, { storageKey: "old.key" })).storageKey, "old.key");
});

test("unknown language and missing name are reported", () => {
  const dir = tmp();
  const file = path.join(dir, "c.json");
  fs.writeFileSync(file, JSON.stringify({ name: "X", lang: "xx" }));
  assert.throws(() => loadConfig(file), /unknown lang "xx"/);
  fs.writeFileSync(file, JSON.stringify({}));
  assert.throws(() => loadConfig(file), /"name" is required/);
});

test("duplicate chunk ids are an error", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "c"));
  fs.writeFileSync(path.join(dir, "c", "a.json"), JSON.stringify([{ id: "x", title: "A", text: "a" }, { id: "x", title: "B", text: "b" }]));
  fs.writeFileSync(path.join(dir, "cfg.json"), JSON.stringify({ name: "X", content: ["c"] }));
  assert.throws(() => build(path.join(dir, "cfg.json"), quiet, { out: path.join(dir, "out") }), /Duplicate chunk id "x"/);
});

test("build writes the widget files, and the Worker without overwriting your code", () => {
  const dir = tmp();
  const out = path.join(dir, "site");
  const worker = path.join(dir, "worker");
  const { knowledge } = build(EXAMPLE, quiet, { out, worker });
  for (const f of ["widget.js", "widget.css", "retrieve.mjs", "lang/en.mjs", "lang/nl.mjs", "knowledge.json", "settings.json"]) {
    assert.ok(fs.existsSync(path.join(out, f)), f);
  }
  for (const f of ["src/index.js", "src/knowledge.js", "src/settings.js", "src/retrieve.mjs", "wrangler.toml", "package.json"]) {
    assert.ok(fs.existsSync(path.join(worker, f)), f);
  }
  assert.ok(knowledge.core.startsWith("You are the assistant of Chess Rules Explained"));
  assert.ok(knowledge.core.includes("# Quick facts"));
  assert.ok(knowledge.chunks.some((c) => c.id === "special-moves#castling" && c.keys.includes("O-O")));

  const workerSettings = fs.readFileSync(path.join(worker, "src", "settings.js"), "utf8");
  assert.ok(!workerSettings.includes("storageKey"));

  fs.writeFileSync(path.join(worker, "src", "index.js"), "// mine");
  build(EXAMPLE, quiet, { out, worker });
  assert.equal(fs.readFileSync(path.join(worker, "src", "index.js"), "utf8"), "// mine");
});

test("the example passes its own checks", () => {
  const lines = [];
  const { failed, total } = check(EXAMPLE, (l) => lines.push(l));
  assert.equal(failed, 0, lines.join("\n"));
  assert.ok(total >= 20);
});
