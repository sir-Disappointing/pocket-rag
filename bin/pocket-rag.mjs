#!/usr/bin/env node
// pocket-rag: a tiny "ask this site" assistant for static sites. Run without arguments for help.
import fs from "node:fs";
import path from "node:path";
import { build, loadConfig, makeKnowledge } from "../src/build.mjs";
import { detect } from "../src/detect.mjs";
import { ask, formatAsk, runChecks, formatChecks, doctor, formatDoctor } from "../src/diagnose.mjs";

const SETUP = "https://raw.githubusercontent.com/sir-Disappointing/pocket-rag/main/SETUP.md";
const USAGE = `pocket-rag: a tiny "ask this site" assistant for static sites.

  pocket-rag init                 Look at this site and write pocket-rag.config.json and checks.json
  pocket-rag build                Build the knowledge base and copy the widget into "out"
  pocket-rag ask "question"       Show which content a question gets, and why
  pocket-rag check                Run the questions in checks.json; explains misses and suggests fixes
  pocket-rag doctor               Check the whole setup: content, build, script tag, CSP, privacy, checks

Options:
  --config <file>     Config file (default: pocket-rag.config.json; build/check/doctor also take it as an argument)
  --previous "…"      ask: the question before this one, for follow-ups
  --json              Machine-readable output (check, ask, doctor, init)

Step-by-step setup guide (for people and AI assistants): ${SETUP}`;

// ------------------------------------------------------------ arguments

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--json" || a === "--help" || a === "-h") flags[a.replace(/^-+/, "")] = true;
  else if (a.startsWith("--")) flags[a.slice(2)] = argv[++i];
  else positional.push(a);
}
const [cmd, ...rest] = positional;
const configPath = flags.config || (cmd !== "ask" && rest[0]) || "pocket-rag.config.json";
const print = (data, text) => console.log(flags.json ? JSON.stringify(data, null, 2) : text);

// ------------------------------------------------------------ init

function init() {
  const site = detect(".");
  const written = [];
  const kept = [];
  const write = (file, text) => {
    if (fs.existsSync(file)) return kept.push(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    written.push(file);
  };

  let content = site.content.filter((c) => c !== "." || site.candidates.length === 1 || site.framework === "static" || site.framework === "jekyll");
  if (!content.length) content = site.content.slice(0, 1);
  if (!site.candidates.length) {
    content = ["content"];
    write("content/about.md", "# About this site\n\nWrite your content in Markdown. Every `##` heading becomes a separate piece the assistant can find.\n\n## Contact\n\nYou can reach us by email.\n");
  }
  const config = {
    name: site.name,
    about: "",
    scope: "",
    lang: site.lang,
    content,
    core: [],
    out: site.out,
    proxyUrl: "",
    ui: { suggestions: [], privacyUrl: "" },
    checks: "checks.json",
  };
  write(configPath, JSON.stringify(config, null, 2) + "\n");
  write("checks.json", "[]\n");

  const report = { detected: site, written, kept, config: fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : config };
  const lines = [
    `Site: ${site.frameworkName}${site.layouts.length ? ` (layout: ${site.layouts.join(", ")})` : ""}`,
    `Published folder: ${site.publicDir}  →  widget goes in ${site.out}/`,
    `Content: ${site.candidates.length ? site.candidates.slice(0, 5).map((c) => `${c.folder} (${c.files} files)`).join(", ") : "none found; created content/about.md"}`,
    `Language: ${site.lang}${site.langSupported ? "" : ` (the site says "${site.langFound}"; no word list for that yet, using en)`}. Name: ${site.name}`,
    "",
    ...written.map((f) => `created: ${f}`),
    ...kept.map((f) => `exists, kept: ${f}`),
    "",
    "Next:",
    `1. In ${configPath}: check "content" (only folders with real pages), and fill in "about" and "scope".`,
    "2. Write 15–30 questions a visitor would ask in checks.json, with the chunk ids you expect (`pocket-rag ask \"…\"` shows ids).",
    "3. Run `pocket-rag build`, then `pocket-rag check` and fix misses with the suggested synonyms.",
    `4. Add the script tag. ${site.script}`,
    "5. Add a privacy note (questions go to Anthropic) and set ui.privacyUrl.",
    "6. Run `pocket-rag doctor` until it's all ✔.",
    "",
    `Full guide: ${SETUP}`,
  ];
  print(report, lines.join("\n"));
}

// ------------------------------------------------------------ commands

try {
  if (!cmd || flags.help || cmd === "help") console.log(USAGE);
  else if (cmd === "init") init();
  else if (cmd === "build") build(configPath);
  else if (cmd === "ask") {
    const question = rest.join(" ").trim();
    if (!question) throw new Error('give a question: pocket-rag ask "How do I …?"');
    const knowledge = makeKnowledge(loadConfig(configPath));
    const r = ask(knowledge, question, flags.previous || "");
    print(r, formatAsk(r));
  } else if (cmd === "check") {
    const r = runChecks(loadConfig(configPath));
    print(r, formatChecks(r));
    process.exitCode = r.failed || r.missing ? 1 : 0;
  } else if (cmd === "doctor") {
    const r = doctor(configPath);
    print(r, formatDoctor(r));
    process.exitCode = r.errors ? 1 : 0;
  } else {
    console.error(`Unknown command "${cmd}".\n`);
    console.log(USAGE);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`pocket-rag: ${err.message}`);
  process.exitCode = 1;
}
