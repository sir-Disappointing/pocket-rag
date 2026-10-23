// pocket-rag widget: a floating "Ask" button with a chat panel that answers from your content.
//
//   <script type="module" src="pocket-rag/widget.js"></script>
//
// Reads settings.json next to this file. Two ways to reach Claude:
//   - via your proxy (settings.proxyUrl), which holds your API key and does the search;
//   - with the visitor's own API key, kept in their browser. Then the search runs here and
//     knowledge.json is loaded on first use.
// The widget lives in a Shadow DOM, so the page's CSS can't break it. Theme it with the
// --pr-* custom properties on the pocket-rag-widget element (see widget.css).
const BASE = new URL(".", import.meta.url);
const ANTHROPIC = "https://api.anthropic.com";

const settings = await fetch(new URL("settings.json", BASE)).then((r) => {
  if (!r.ok) throw new Error(`pocket-rag: settings.json not found (${r.status})`);
  return r.json();
});
const S = settings.strings;
const viaProxy = Boolean(settings.proxyUrl);

const state = { open: false, busy: false, history: [], knowledge: null, retrieve: null };

const readKey = () => {
  try {
    return localStorage.getItem(settings.storageKey) || "";
  } catch {
    return "";
  }
};
let sessionKey = readKey();
const writeKey = (key) => {
  try {
    if (key) localStorage.setItem(settings.storageKey, key);
    else localStorage.removeItem(settings.storageKey);
  } catch {
    // No storage (private window): the key only lasts for this page.
  }
  sessionKey = key;
};

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

// Safe rendering: escape everything first, then **bold**, lists and paragraphs.
function renderText(target, text) {
  const esc = text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  const blocks = esc
    .trim()
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n");
      if (lines.every((l) => /^\s*[-•*]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${l.replace(/^\s*[-•*]\s+/, "")}</li>`).join("")}</ul>`;
      return `<p>${lines.join("<br>")}</p>`;
    });
  target.innerHTML = blocks.join("").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

// ------------------------------------------------------------ layout

const host = document.createElement("pocket-rag-widget");
host.style.visibility = "hidden"; // until the stylesheet has loaded
const root = host.attachShadow({ mode: "open" });
const css = el("link");
css.rel = "stylesheet";
css.href = new URL("widget.css", BASE).href;
css.addEventListener("load", () => (host.style.visibility = ""));

const fab = el("button", "fab");
fab.type = "button";
fab.setAttribute("aria-expanded", "false");
fab.setAttribute("aria-controls", "panel");
fab.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/></svg>';
fab.appendChild(el("span", null, S.label));

const panel = el("section", "panel hidden");
panel.id = "panel";
panel.setAttribute("aria-label", S.title);
const head = el("header", "head");
const headText = el("div");
headText.append(el("h2", null, S.title), el("p", null, S.subtitle));
const notice = el("p", null, S.notice + " ");
if (settings.privacyUrl) {
  const a = el("a", null, S.privacy);
  a.href = settings.privacyUrl;
  a.target = "_blank";
  a.rel = "noopener";
  notice.appendChild(a);
}
headText.appendChild(notice);
const closeBtn = el("button", "icon");
closeBtn.type = "button";
closeBtn.setAttribute("aria-label", S.close);
closeBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
head.append(headText, closeBtn);

const body = el("div", "body");
body.setAttribute("aria-live", "polite");
const form = el("form", "ask");
const inputLabel = el("label", "visually-hidden", S.inputLabel);
inputLabel.htmlFor = "pr-input";
const input = el("textarea");
input.id = "pr-input";
input.rows = 1;
input.maxLength = settings.maxQuestion;
input.placeholder = S.placeholder;
const send = el("button", "btn", S.send);
send.type = "submit";
form.append(inputLabel, input, send);
const foot = el("footer", "foot");
panel.append(head, body, form, foot);
root.append(css, fab, panel);
document.body.appendChild(host);

function renderFoot() {
  foot.replaceChildren();
  if (state.history.length) {
    const reset = el("button", "link", S.newChat);
    reset.type = "button";
    reset.addEventListener("click", () => {
      state.history = [];
      renderWelcome();
    });
    foot.appendChild(reset);
  }
  if (!viaProxy && sessionKey) {
    const change = el("button", "link", S.changeKey);
    change.type = "button";
    change.addEventListener("click", () => {
      writeKey("");
      renderWelcome();
    });
    foot.appendChild(change);
  }
}

const needsKey = () => !viaProxy && !sessionKey;

function renderKeyForm() {
  body.replaceChildren();
  form.classList.add("hidden");
  const box = el("div", "key");
  box.appendChild(el("p", null, S.keyIntro));
  const f = el("form");
  const label = el("label", "field", S.keyLabel);
  const key = el("input");
  key.type = "password";
  key.autocomplete = "off";
  key.placeholder = "sk-ant-…";
  label.appendChild(key);
  const save = el("button", "btn", S.keySave);
  save.type = "submit";
  f.append(label, save);
  f.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = key.value.trim();
    if (!v) return;
    writeKey(v);
    renderWelcome();
    input.focus();
  });
  box.append(f, el("p", "small", S.keyNote));
  body.appendChild(box);
  renderFoot();
  key.focus();
}

function renderWelcome() {
  if (needsKey()) return renderKeyForm();
  form.classList.remove("hidden");
  body.replaceChildren();
  const intro = el("div", "msg from-assistant");
  renderText(intro, S.welcome);
  body.appendChild(intro);
  if (settings.suggestions.length) {
    const chips = el("div", "suggestions");
    for (const s of settings.suggestions) {
      const b = el("button", "chip", s);
      b.type = "button";
      b.addEventListener("click", () => ask(s));
      chips.appendChild(b);
    }
    body.appendChild(chips);
  }
  renderFoot();
}

function addMessage(role, text) {
  const m = el("div", `msg from-${role}`);
  if (role === "user") m.textContent = text;
  else renderText(m, text);
  body.appendChild(m);
  body.scrollTop = body.scrollHeight;
  return m;
}

// ------------------------------------------------------------ Claude

class ApiError extends Error {
  constructor(status, type, message) {
    super(message || type);
    this.status = status;
    this.type = type;
  }
}

// Streams a Messages API response (server-sent events) and calls onText for each piece of text.
async function stream(url, headers, payload, onText) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload) });
  if (!res.ok) {
    let err = {};
    try {
      err = (await res.json()).error || {};
    } catch {}
    throw new ApiError(res.status, err.type, err.message);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let stopReason = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let cut;
    while ((cut = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const data = raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      const ev = JSON.parse(data);
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") onText(ev.delta.text);
      else if (ev.type === "message_delta") stopReason = ev.delta.stop_reason;
      else if (ev.type === "error") throw new ApiError(529, ev.error.type, ev.error.message);
    }
  }
  return stopReason;
}

async function request(messages, onText) {
  if (viaProxy) return stream(new URL("/v1/messages", settings.proxyUrl), {}, { messages }, onText);
  if (!state.knowledge) {
    const [knowledge, retrieve] = await Promise.all([
      fetch(new URL("knowledge.json", BASE)).then((r) => r.json()),
      import(new URL("retrieve.js", BASE).href),
    ]);
    state.knowledge = knowledge;
    state.retrieve = retrieve;
  }
  const payload = state.retrieve.requestBody(state.knowledge, settings, messages);
  return stream(
    `${ANTHROPIC}/v1/messages`,
    { "x-api-key": sessionKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    payload,
    onText
  );
}

function errorText(err) {
  if (!(err instanceof ApiError)) return err instanceof TypeError ? S.errOffline : S.errGeneric;
  if (err.status === 401) return viaProxy ? S.errGeneric : S.errKey;
  if (err.status === 403) return S.errForbidden;
  if (err.status === 429) return (viaProxy && err.message) || S.errRate;
  if (err.status === 400) return S.errBadRequest;
  if (err.status === 529 || err.type === "overloaded_error") return S.errBusy;
  return (viaProxy && err.message) || S.errGeneric;
}

async function ask(question) {
  const q = question.trim();
  if (!q || state.busy) return;
  state.busy = true;
  send.disabled = true;
  body.querySelector(".suggestions")?.remove();

  state.history.push({ role: "user", content: q });
  addMessage("user", q);
  const answer = addMessage("assistant", "");
  answer.classList.add("is-typing");

  // Keep the conversation short: the last messages, starting with a question.
  let messages = state.history.slice(-settings.maxHistory);
  if (messages[0].role !== "user") messages = messages.slice(1);

  let text = "";
  try {
    const stop = await request(messages, (delta) => {
      text += delta;
      answer.classList.remove("is-typing");
      renderText(answer, text);
      body.scrollTop = body.scrollHeight;
    });
    if (stop === "refusal") text = S.refusal;
    else if (stop === "max_tokens") text += `\n\n${S.truncated}`;
    if (!text.trim()) text = S.empty;
    renderText(answer, text);
    state.history.push({ role: "assistant", content: text });
  } catch (err) {
    console.error("pocket-rag:", err);
    state.history.pop(); // don't keep the question, so it can be asked again
    answer.classList.add("is-error");
    renderText(answer, errorText(err));
  } finally {
    answer.classList.remove("is-typing");
    state.busy = false;
    send.disabled = false;
    renderFoot();
    body.scrollTop = body.scrollHeight;
  }
}

// ------------------------------------------------------------ controls

function setOpen(open) {
  state.open = open;
  panel.classList.toggle("hidden", !open);
  fab.setAttribute("aria-expanded", String(open));
  fab.classList.toggle("is-open", open);
  if (open) {
    if (!body.childElementCount) renderWelcome();
    (needsKey() ? body.querySelector(".key input") : input)?.focus();
  }
}

fab.addEventListener("click", () => setOpen(!state.open));
closeBtn.addEventListener("click", () => {
  setOpen(false);
  fab.focus();
});
panel.addEventListener("keydown", (e) => {
  // Keys typed in the chat shouldn't reach the page's own shortcuts.
  e.stopPropagation();
  if (e.key === "Escape") {
    setOpen(false);
    fab.focus();
  }
});
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = input.value;
  input.value = "";
  input.style.height = "";
  ask(q);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
});

// For the host page: open the panel from your own button, or ask a question from a link.
window.pocketRag = {
  open: () => setOpen(true),
  close: () => setOpen(false),
  ask: (q) => {
    setOpen(true);
    if (!needsKey()) ask(q);
  },
};
