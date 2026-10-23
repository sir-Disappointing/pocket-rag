// Browser test of the widget on the example site, with a mocked Anthropic API.
// Needs Playwright: npm i -D playwright && npx playwright install chromium
// Run: npm run example && node test/e2e/browser.mjs [screenshot-dir]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "example", "site");
const SHOTS = process.argv[2];
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json" };

let failed = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${extra && !ok ? ` (${extra})` : ""}`);
};

const server = http
  .createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/\/$/, "/index.html"));
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" }).end(fs.readFileSync(file));
  })
  .listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const URL_ = `http://127.0.0.1:${server.address().port}/`;

const sse = (text, stop = "end_turn") =>
  [
    ["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ...text.match(/.{1,12}/gs).map((t) => ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }]),
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 5 } }],
    ["message_stop", { type: "message_stop" }],
  ]
    .map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)
    .join("");

const browser = await chromium.launch();

async function page(opts = {}) {
  const p = await browser.newPage(opts.viewport ? { viewport: opts.viewport } : {});
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => (window.__csp = (window.__csp || []).concat(`${e.violatedDirective} ${e.blockedURI}`))));
  const calls = [];
  let reply = { status: 200, body: sse("**Castling** is a king move.\n\n- King two squares\n- Rook jumps over") };
  await p.route("https://api.anthropic.com/**", (route) => {
    const r = route.request();
    calls.push({ headers: r.headers(), body: r.postDataJSON() });
    route.fulfill({ status: reply.status, headers: { "content-type": reply.status === 200 ? "text/event-stream" : "application/json", "access-control-allow-origin": "*" }, body: reply.body });
  });
  return { p, calls, errors, setReply: (r) => (reply = r) };
}

// ------------------------------------------------------------ own key
{
  const { p, calls, errors, setReply } = await page();
  await p.goto(URL_);
  await p.waitForSelector("pocket-rag-widget .fab");
  check("knowledge not loaded before opening", !(await p.evaluate(() => performance.getEntriesByType("resource").some((e) => e.name.includes("knowledge.json")))));
  check("button label", (await p.locator("pocket-rag-widget .fab").innerText()).includes("Ask"));
  check("themed accent from the host page", (await p.locator("pocket-rag-widget .fab").evaluate((el) => getComputedStyle(el).getPropertyValue("--pr-accent").trim())) === "#7a3e9d");

  await p.click("pocket-rag-widget .fab");
  check("asks for a key first", await p.locator("pocket-rag-widget .key input").isVisible());
  check("privacy link in the panel", (await p.locator("pocket-rag-widget .head a").getAttribute("href")) === "privacy.html");
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/1-key.png` });
  await p.fill("pocket-rag-widget .key input", "sk-ant-test-key");
  await p.click("pocket-rag-widget .key .btn");
  check("suggestions shown", (await p.locator("pocket-rag-widget .chip").count()) === 3);

  await p.click("pocket-rag-widget .chip >> nth=0");
  await p.waitForFunction(() => document.querySelector("pocket-rag-widget").shadowRoot.querySelector(".from-assistant strong"));
  await p.waitForFunction(() => !document.querySelector("pocket-rag-widget").shadowRoot.querySelector(".is-typing"));
  const c = calls[0];
  check("direct: key and browser headers", c.headers["x-api-key"] === "sk-ant-test-key" && c.headers["anthropic-dangerous-direct-browser-access"] === "true" && c.headers["anthropic-version"] === "2023-06-01");
  check("direct: model, limits, effort, stream", c.body.model === "claude-haiku-5-5" && c.body.max_tokens === 800 && c.body.output_config.effort === "low" && c.body.stream === true);
  check("direct: cached core as system", c.body.system[0].cache_control.type === "ephemeral" && c.body.system[0].text.startsWith("You are the assistant of Chess Rules Explained"));
  check("direct: matching source sent", c.body.messages[0].content.includes('<source title="Special moves › Castling">'));
  check("answer rendered: bold and list", (await p.locator("pocket-rag-widget .from-assistant strong").count()) === 1 && (await p.locator("pocket-rag-widget .from-assistant li").count()) === 2);
  check("key stored for this site only", await p.evaluate(() => localStorage.getItem("pocket-rag:chess-rules-explained:key") === "sk-ant-test-key"));
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/2-answer.png` });

  setReply({ status: 200, body: sse('<img src=x onerror="window.__xss=1"> plain') });
  await p.fill("pocket-rag-widget textarea", "And en passant?");
  await p.press("pocket-rag-widget textarea", "Enter");
  await p.waitForFunction(() => document.querySelector("pocket-rag-widget").shadowRoot.querySelectorAll(".from-assistant").length === 3 && !document.querySelector("pocket-rag-widget").shadowRoot.querySelector(".is-typing"));
  const c2 = calls[1];
  check("follow-up: history sent, previous answer cached", c2.body.messages.length === 3 && c2.body.messages[1].content[0].cache_control?.type === "ephemeral" && c2.body.messages[0].content === "How does castling work?");
  check("HTML in answers is escaped", !(await p.evaluate(() => window.__xss)) && (await p.locator("pocket-rag-widget img").count()) === 0);

  setReply({ status: 401, body: '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' });
  await p.fill("pocket-rag-widget textarea", "Is stalemate a win?");
  await p.press("pocket-rag-widget textarea", "Enter");
  await p.waitForSelector("pocket-rag-widget .is-error");
  check("401 explains the key", (await p.locator("pocket-rag-widget .is-error").innerText()).includes("API key isn't valid"));

  await p.keyboard.press("Escape");
  check("Escape closes", !(await p.locator("pocket-rag-widget .panel").isVisible()));

  setReply({ status: 200, body: sse("Yes, you may.") });
  await p.click(".ask-link");
  await p.waitForFunction(() => [...document.querySelector("pocket-rag-widget").shadowRoot.querySelectorAll(".from-user")].some((m) => m.textContent === "Can I castle out of check?"));
  check("pocketRag.ask() from the page", true);

  await p.click("pocket-rag-widget .foot .link >> text=Change key");
  check("change key returns to the key form", await p.locator("pocket-rag-widget .key input").isVisible());

  const csp = await p.evaluate(() => window.__csp || []);
  check("no CSP violations", csp.length === 0, csp.join(" | "));
  check("no page errors", errors.length === 0, errors.join(" | "));
  await p.close();
}

// ------------------------------------------------------------ proxy
{
  const { p, errors } = await page();
  const proxied = [];
  await p.route("**/pocket-rag/settings.json", async (route) => {
    const res = await route.fetch();
    const s = await res.json();
    route.fulfill({ response: res, body: JSON.stringify({ ...s, proxyUrl: "https://proxy.test" }) });
  });
  await p.route(/127\.0\.0\.1:\d+\/(index\.html)?$/, async (route) => {
    const res = await route.fetch();
    route.fulfill({ response: res, body: (await res.text()).replace("connect-src 'self' https://api.anthropic.com", "connect-src 'self' https://api.anthropic.com https://proxy.test") });
  });
  let status = 200;
  await p.route("https://proxy.test/**", (route) => {
    proxied.push({ url: route.request().url(), body: route.request().postDataJSON() });
    route.fulfill(
      status === 200
        ? { status, headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" }, body: sse("Via the proxy.") }
        : { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: '{"type":"error","error":{"type":"rate_limit_error","message":"Slow down from the proxy."}}' }
    );
  });
  await p.goto(URL_);
  await p.click("pocket-rag-widget .fab");
  check("proxy: no key form", (await p.locator("pocket-rag-widget .key").count()) === 0);
  await p.fill("pocket-rag-widget textarea", "What is en passant?");
  await p.press("pocket-rag-widget textarea", "Enter");
  await p.waitForFunction(() => document.querySelector("pocket-rag-widget").shadowRoot.querySelector(".from-assistant:last-of-type")?.textContent.includes("Via the proxy"));
  check("proxy: only the conversation is sent", proxied[0].url === "https://proxy.test/v1/messages" && JSON.stringify(Object.keys(proxied[0].body)) === '["messages"]');
  check("proxy: knowledge never loaded", !(await p.evaluate(() => performance.getEntriesByType("resource").some((e) => e.name.includes("knowledge.json")))));
  status = 429;
  await p.fill("pocket-rag-widget textarea", "Again?");
  await p.press("pocket-rag-widget textarea", "Enter");
  await p.waitForSelector("pocket-rag-widget .is-error");
  check("proxy: shows the proxy's 429 message", (await p.locator("pocket-rag-widget .is-error").innerText()).includes("Slow down from the proxy."));
  check("proxy: no page errors", errors.length === 0, errors.join(" | "));
  await p.close();
}

// ------------------------------------------------------------ mobile and dark
{
  const { p } = await page({ viewport: { width: 375, height: 700 } });
  await p.emulateMedia({ colorScheme: "dark" });
  await p.goto(URL_);
  await p.click("pocket-rag-widget .fab");
  const box = await p.locator("pocket-rag-widget .panel").boundingBox();
  check("mobile: panel fills the screen", box.width === 375 && box.x === 0);
  check("no horizontal scroll", await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check("dark: panel is dark", (await p.locator("pocket-rag-widget .panel").evaluate((el) => getComputedStyle(el).backgroundColor)) === "rgb(26, 29, 35)");
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/3-mobile-dark.png` });
  await p.close();
}

await browser.close();
server.close();
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
