#!/usr/bin/env node
// pocket-rag init | build | check  [config file, default pocket-rag.config.json]
import fs from "node:fs";
import path from "node:path";
import { build, check } from "../src/build.mjs";

const [cmd, configArg] = process.argv.slice(2);
const configPath = configArg || "pocket-rag.config.json";

const USAGE = `pocket-rag: a tiny "ask this site" assistant for static sites.

  pocket-rag init    Create pocket-rag.config.json, a content/ folder and checks.json here
  pocket-rag build   Build the knowledge base and copy the widget into "out" (and "worker")
  pocket-rag check   Test the search against the questions in checks.json

Each command takes an optional config path (default: pocket-rag.config.json).`;

function init() {
  const write = (file, text) => {
    if (fs.existsSync(file)) return console.log(`exists, kept: ${file}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    console.log(`created: ${file}`);
  };
  write(
    configPath,
    JSON.stringify(
      {
        name: "My site",
        about: "a website about …",
        scope: "the topics of this website",
        lang: "en",
        content: ["content"],
        core: [],
        out: "pocket-rag",
        proxyUrl: "",
        ui: { suggestions: ["What is this site about?"], privacyUrl: "" },
        checks: "checks.json",
      },
      null,
      2
    ) + "\n"
  );
  write(
    "content/about.md",
    "# About this site\n\nWrite your content in Markdown. Every `##` heading becomes a separate piece the assistant can find.\n\n## Contact\n\nYou can reach us by email.\n"
  );
  write("checks.json", JSON.stringify([{ q: "How can I contact you?", expect: ["about#contact"] }], null, 2) + "\n");
  console.log(`\nNext: edit ${configPath}, add content, run "pocket-rag build", then add to your page:\n  <script type="module" src="pocket-rag/widget.js"></script>`);
}

try {
  if (cmd === "init") init();
  else if (cmd === "build") build(configPath);
  else if (cmd === "check") process.exitCode = check(configPath).failed ? 1 : 0;
  else {
    console.log(USAGE);
    process.exitCode = cmd && cmd !== "help" && cmd !== "--help" ? 1 : 0;
  }
} catch (err) {
  console.error(`pocket-rag: ${err.message}`);
  process.exitCode = 1;
}
