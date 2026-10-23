import test from "node:test";
import assert from "node:assert/strict";
import { retrieve, withSources, requestBody, normalize } from "../src/retrieve.mjs";
import * as en from "../src/lang/en.mjs";
import * as nl from "../src/lang/nl.mjs";

const chunk = (id, title, text, keys) => ({ id, title, text, ...(keys ? { keys } : {}) });

const EN = {
  lang: "en",
  core: "You are a helper.",
  chunks: [
    chunk("parking", "Parking", "Parking is not allowed on the pavement or within 5 metres of a junction."),
    chunk("speed", "Speed limits", "The speed limit in town is 50 km/h unless signs say otherwise."),
    chunk("signs#b6", "Sign B6", "Give way to traffic on the road you are entering.", ["B6"]),
    chunk("phones", "Mobile devices", "Holding a mobile device while driving is prohibited."),
    chunk("lights", "Lights", "Use dipped headlights at night and in poor visibility."),
  ],
};

test("normalize strips case and accents", () => {
  assert.equal(normalize("Één Café"), "een cafe");
});

test("English variants find the stem", () => {
  assert.ok(en.variants("parking").includes("park"));
  assert.ok(en.variants("stopped").includes("stop"));
  assert.ok(en.variants("batteries").includes("battery"));
});

test("Dutch variants find the stem", () => {
  assert.ok(nl.variants("parkeren").includes("parkeer"));
  assert.ok(nl.variants("remmen").includes("rem"));
});

test("finds the matching chunk by content words", () => {
  assert.equal(retrieve(EN, "Where can I park my car?")[0].id, "parking");
  assert.equal(retrieve(EN, "How fast may I drive in town?")[0].id, "speed");
});

test("built-in synonyms translate everyday words", () => {
  assert.equal(retrieve(EN, "Can I use my phone while driving?")[0].id, "phones");
});

test("custom synonyms and phrases from the knowledge base", () => {
  const k = { ...EN, synonyms: { lamps: ["headlights"] }, phrases: { "how quick": ["speed"] } };
  assert.equal(retrieve(k, "When do I need my lamps?")[0].id, "lights");
  assert.equal(retrieve(k, "how quick in town?")[0].id, "speed");
});

test("keys match literally, also with a space", () => {
  assert.equal(retrieve(EN, "What does B6 mean?")[0].id, "signs#b6");
  assert.equal(retrieve(EN, "and b 6?")[0].id, "signs#b6");
});

test("nothing for off-topic or empty questions", () => {
  assert.deepEqual(retrieve(EN, "What is the capital of France?"), []);
  assert.deepEqual(retrieve(EN, "what is it?"), []);
});

test("a follow-up keeps the topic of the previous question", () => {
  const ids = retrieve(EN, "And at night?", "What is the speed limit?").map((c) => c.id);
  assert.ok(ids.includes("lights") && ids.includes("speed"), ids.join());
});

test("tuning limits the number of chunks", () => {
  const many = { ...EN, chunks: Array.from({ length: 30 }, (_, i) => chunk(`c${i}`, `Parking ${i}`, "parking rules")), tuning: { maxChunks: 3 } };
  assert.equal(retrieve(many, "parking").length, 3);
});

test("boost prefers chunks by id prefix", () => {
  const k = { ...EN, chunks: [chunk("law/1", "Parking law", "parking"), chunk("guide/1", "Parking guide", "parking")] };
  assert.equal(retrieve(k, "parking")[0].id, "law/1");
  assert.equal(retrieve({ ...k, tuning: { boost: { "guide/": 1.5 } } }, "parking")[0].id, "guide/1");
});

test("withSources wraps the last question and marks the previous answer for caching", () => {
  const first = withSources(EN, [{ role: "user", content: "Where can I park?" }]);
  assert.equal(first.length, 1);
  assert.match(first[0].content, /^<sources>\n<source title="Parking">/);
  assert.match(first[0].content, /<question>\nWhere can I park\?\n<\/question>$/);
  assert.ok(!JSON.stringify(first).includes("cache_control"));

  const conv = withSources(EN, [
    { role: "user", content: "Where can I park?" },
    { role: "assistant", content: "Not on the pavement." },
    { role: "user", content: "And B6?" },
  ]);
  assert.equal(conv[0].content, "Where can I park?");
  assert.deepEqual(conv[1].content, [{ type: "text", text: "Not on the pavement.", cache_control: { type: "ephemeral" } }]);
  assert.match(conv[2].content, /<source title="Sign B6">/);
});

test("Dutch knowledge uses Dutch tags", () => {
  const k = { lang: "nl", core: "", chunks: [chunk("p", "Parkeren", "Parkeren mag niet op de stoep.")] };
  const [m] = withSources(k, [{ role: "user", content: "Mag ik parkeren op de stoep?" }]);
  assert.match(m.content, /^<bronnen>\n<bron titel="Parkeren">/);
  assert.match(m.content, /<vraag>/);
});

test("no sources gives a clear marker", () => {
  const [m] = withSources(EN, [{ role: "user", content: "Tell me a joke" }]);
  assert.match(m.content, /\(no matching sources found\)/);
});

test("requestBody sets model, limits, cached system and effort", () => {
  const body = requestBody(EN, { model: "claude-haiku-5-5", maxTokens: 800, effort: "low" }, [{ role: "user", content: "parking?" }]);
  assert.equal(body.model, "claude-haiku-5-5");
  assert.equal(body.max_tokens, 800);
  assert.equal(body.stream, true);
  assert.deepEqual(body.output_config, { effort: "low" });
  assert.deepEqual(body.system, [{ type: "text", text: "You are a helper.", cache_control: { type: "ephemeral" } }]);
  assert.ok(!("output_config" in requestBody(EN, { model: "m", maxTokens: 1 }, [{ role: "user", content: "x" }])));
});
