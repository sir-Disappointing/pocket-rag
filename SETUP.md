# Setting up pocket-rag

This is the step-by-step guide for adding pocket-rag to a website. It is written so an AI coding assistant can follow it without further instructions, and it works just as well for people.

**What you'll end up with:** a "Ask" button on the site that answers visitors' questions from the site's own content, using Claude. It's static files only; no server is needed.

**If you are an AI assistant:** follow the steps in order. The commands print what to do next; `pocket-rag doctor` is the finish line. Ask the site owner only what step 3 asks; use the defaults here for everything else, and tell the owner what you chose at the end.

## Ground rules

- **Never put an API key in the site, the config or the repository.** Not even temporarily, not even in a comment. Everything in a static site is public. Visitors enter their own key in the chat (it stays in their browser), or the owner stores theirs as a Cloudflare secret themselves (step 3).
- **Don't copy or rewrite the site's content** for the assistant. Point pocket-rag at the existing pages or Markdown.
- **Don't edit generated files** (the `out` folder, `worker/src/knowledge.js`, `settings.js`, `retrieve.mjs`, `lang/`). Change the config or the content and build again.
- **Fix search misses properly** (step 9): add synonyms only between words that mean the same thing, and never change a check's expected answer just to make it pass.

## 1. Run `init`

Node 20 or newer is required. In the site's root folder:

```sh
npx --yes github:sir-Disappointing/pocket-rag#v0.3.0 init
```

If the site has a `package.json`, install it as a dev dependency instead, so the version is pinned and the command is short:

```sh
npm install --save-dev github:sir-Disappointing/pocket-rag#v0.3.0
npx pocket-rag init
```

In the rest of this guide, `pocket-rag` means either form.

`init` looks at the site, then writes `pocket-rag.config.json` and an empty `checks.json`. It detects:
- the framework (plain HTML, Hugo, Jekyll, Eleventy, Astro, Next.js, Vite, Docusaurus, VitePress, MkDocs);
- the published folder;
- the content folders;
- the language and the site name.

Read its output: it tells you where the widget goes and how to load it on this kind of site. `--json` gives the same as data.

## 2. Fill in the config

Open `pocket-rag.config.json`:

- **`name`**: the site's name, as visitors know it.
- **`about`**: half a sentence that completes "You are the assistant of <name>, …", e.g. `"a bakery on Elm Street in Utrecht"`.
- **`scope`**: what the assistant answers questions about, e.g. `"our bread, opening hours, orders and allergies"`. Other questions are politely declined.
- **`content`**: the folders or files with the real pages. Supported: Markdown (`.md`, `.mdx`), HTML (`.html`; only the main text is used, and navigation, header and footer are skipped), JSON (`[{ "title", "text" }]`) and `.txt`.
  - Leave out pages that don't help answer questions (legal, 404, tag and archive pages) with a top-level `"exclude"` list. Its paths are relative to the config file, like `content`: `"exclude": ["src/404.md", "src/tags"]`. Keeping the privacy page in is fine: then the assistant can answer "what happens to my questions?".
  - `node_modules`, build output and pocket-rag's own folders are skipped automatically.
- **`lang`**: `"en"` or `"nl"`. It sets the search's word lists and the chat's texts. For another language, use `"en"`: answers still come in the visitor's language.
- **`ui.suggestions`**: two or three questions a visitor would really ask, shown as buttons.
- **`ui.welcome`**: the chat's first message. The default is "Hi! Ask me anything about this site."; something specific is friendlier, e.g. "Hi! Ask me about opening hours, orders or allergies."
- **`core`** (optional): a list of Markdown files sent with every question, e.g. `"core": ["assistant-core.md"]`. Use it for the 10–30 most important facts (contact details, opening hours, prices, the main rules), so they're always at hand. Keep it under about 1,500 words. `build` and `doctor` report the size of the whole system prompt, which is the instructions plus these files; it's never empty, even with `"core": []`.

Leave `out` as `init` set it, unless the site publishes from a different folder.

## 3. Decide who pays: ask the owner

This is the one real decision. Ask the owner, unless they already said:

- **Visitors use their own Anthropic API key** (the default, and the right choice when in doubt). Nothing else to set up. Visitors without a key see a short form explaining how to get one.
- **The owner pays, through a small proxy.** Set `"worker": "worker"` in the config. The build then creates a Cloudflare Worker in `worker/`.

  Set `ALLOWED_ORIGINS` in `worker/wrangler.toml` to the site's address. Then the **owner** runs these steps themselves:

  ```sh
  cd worker && npm install && npx wrangler login
  npx wrangler secret put ANTHROPIC_API_KEY
  npx wrangler deploy
  ```

  The owner should also set a monthly spending limit on the key in the Anthropic Console (under Limits). Put the address `deploy` prints in `"proxyUrl"`.

  Don't run `wrangler login`, `secret put` or `deploy` yourself, and don't ask for the key.

## 4. Build

```sh
pocket-rag build
```

This writes the widget and the knowledge base into `out` (and the Worker's data into `worker/src/`, if set).

## 5. Load the widget on every page

Add one module script to the shared layout, so every page has it. `init` and `doctor` print the exact line for the site's framework:

| Site | Where | Line |
| --- | --- | --- |
| Plain HTML | each page, before `</body>` | `<script type="module" src="pocket-rag/widget.js"></script>` (path relative to the page) |
| Hugo | `layouts/_default/baseof.html` | `<script type="module" src="{{ "pocket-rag/widget.js" \| relURL }}"></script>` |
| Jekyll | `_layouts/default.html` | `<script type="module" src="{{ "/pocket-rag/widget.js" \| relative_url }}"></script>` |
| Eleventy | base layout in `_includes/` | `<script type="module" src="/pocket-rag/widget.js"></script>`, plus `eleventyConfig.addPassthroughCopy("pocket-rag")` |
| Astro | base layout in `src/layouts/` | `<script is:inline type="module" src="/pocket-rag/widget.js"></script>` |
| Next.js | `app/layout` or `pages/_document` | `<script type="module" src="/pocket-rag/widget.js" async></script>` |
| Vite | `index.html` | `<script type="module" src="/pocket-rag/widget.js"></script>` (the files are in `public/`) |
| Docusaurus | `docusaurus.config` | `scripts: [{ src: "/pocket-rag/widget.js", type: "module" }]` |
| VitePress | `.vitepress/config` | `head: [["script", { type: "module", src: "/pocket-rag/widget.js" }]]` |
| MkDocs | `mkdocs.yml` | `extra_javascript: [{ path: pocket-rag/widget.js, type: module }]` |

- **`type="module"` is required.**
- **Base path:** if the site lives under a sub-path (a GitHub Pages project site like `user.github.io/repo/`), a root path such as `/pocket-rag/widget.js` points to the wrong place. Use a relative path or the framework's base-URL helper.
- **Hiding it on some pages:** add `pocket-rag-widget { display: none; }` to their CSS. For example, drive-alone hides it during exams with `body.in-exam pocket-rag-widget { display: none; }`.

## 6. Content-Security-Policy

If the site has a CSP (a `<meta http-equiv="Content-Security-Policy">` tag, or a header in `_headers`, `netlify.toml` or `vercel.json`):
- `connect-src` must allow `https://api.anthropic.com`, or the proxy's address when there is a proxy;
- `script-src` and `style-src` must allow `'self'`.

The widget needs no `unsafe-inline`. If there's no CSP, change nothing. `doctor` checks this.

## 7. Privacy

Questions go to Anthropic, so the site must say so. If the site has a privacy page, add a short section; if not, create one:

> **The assistant.** When you use the "Ask" button, your question, the recent conversation and the matching parts of this site are sent to Anthropic (USA) to generate an answer. With your own API key, this goes straight from your browser to Anthropic, and the key stays in your browser. [With a proxy: The request passes through our proxy at Cloudflare, which sees your IP address to limit the number of questions, and doesn't store the conversation.] We don't store your questions. Under Anthropic's commercial terms, API conversations are not used for training by default; see [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy). Please don't type personal information into the assistant.

In Dutch:

> **De assistent.** Als je de knop "Vraag het" gebruikt, gaan je vraag, de laatste berichten van het gesprek en de passende stukken van deze site naar Anthropic (VS) om een antwoord te maken. Met je eigen API-sleutel gaat dat rechtstreeks van je browser naar Anthropic, en blijft de sleutel in je browser. [Met een proxy: Het verzoek gaat via onze proxy bij Cloudflare, die je IP-adres ziet om het aantal vragen te beperken en het gesprek niet bewaart.] Wij bewaren je vragen niet. Volgens de zakelijke voorwaarden van Anthropic worden API-gesprekken standaard niet gebruikt om modellen te trainen; zie het [privacybeleid van Anthropic](https://www.anthropic.com/legal/privacy). Typ geen persoonsgegevens in de assistent.

Set `ui.privacyUrl` to the page (`"privacy.html"`, `"/privacy/"` or `"#privacy"`). The chat links to it next to its notice.

## 8. Match the site's look

The widget sits in a Shadow DOM: the site's CSS can't break it, and it can't break the site. Style it with custom properties in the site's global stylesheet. Use the site's existing colour variables where there are any, so dark mode follows automatically:

```css
pocket-rag-widget {
  --pr-accent: var(--brand, #1a4fa0);   /* send button, the visitor's messages */
  --pr-accent-hover: #123a78;
  --pr-on-accent: #fff;                 /* text on the accent colour */
  --pr-fab: #16181d;                    /* the floating button */
  --pr-fab-icon: #f2a900;
  --pr-font: inherit;                   /* or the site's font family */
  --pr-radius: 16px;
}
```

Other properties:
- `--pr-on-fab`: text and icon colour on the floating button;
- `--pr-fab-hover`: the button's hover colour;
- `--pr-bg`, `--pr-soft`, `--pr-text`, `--pr-muted`, `--pr-line`, `--pr-line-strong`: the panel;
- `--pr-error-bg`, `--pr-error-text`: error messages.

All of them, with their defaults, are at the top of `widget.css` in the output folder.

**Dark mode:** the widget follows the visitor's light/dark setting by itself. Any property you set replaces its default in both modes:
- **If the site has a dark mode** with its own variables, use those variables (as above), and both modes match.
- **If the site has no dark mode,** set only the accent and font: everything else keeps adapting. Or set the panel colours too, so the widget stays light like the site.

Check that text on `--pr-accent` stays readable in every mode the site has.

## 9. Test the search with real questions

This step decides whether the assistant gives good answers, so don't skip it.

Write 15–30 questions in `checks.json`, worded the way a visitor would ask them: short, informal, using their own words rather than the site's headings. Cover every important page. Add a follow-up or two (`"previous"`), and a code or number if the site has those (product numbers, rule numbers).

```json
[
  { "q": "Are you open on Sunday?", "expect": ["hours#weekend"] },
  { "q": "can i get a birthday cake tomorrow", "expect": ["hours#orders"] },
  { "q": "And on Saturday?", "previous": "When do you open?", "expect": ["hours#weekend"] }
]
```

`expect` lists the ids of the sections that answer the question (any one is enough). Ids are `file#heading-slug`; a prefix like `"hours"` matches every section of that file. `pocket-rag ask "question"` shows the ids, which sections a question gets, and why.

Then run:

```sh
pocket-rag check
```

For every miss it says why, and what to change:

- **A word visitors use isn't in the content** ("horse" when the site says "knight"): add a synonym, `"synonyms": { "horse": ["knight"] }`. Only between words that mean the same thing.
- **A phrase means a word** ("who goes first" → "priority"): `"phrases": { "who goes first": ["priority"] }`.
- **Codes and numbers** ("B6", "art. 15", "SKU 1234"): add `<!-- keys: B6 -->` in that section (Markdown or HTML), or `"keys"` in JSON. A question containing the key always gets that section.
- **The right section loses to others:** its heading probably doesn't say what it's about. Better headings help visitors too. Otherwise use `"tuning": { "boost": { "guide/": 1.25 } }` to prefer sections whose id starts with that prefix.
- **Words that are everywhere** (the site's own name, or "bord" on a traffic-sign site): `"stopwords": ["…"]`.

`check` and `ask` read the config and the content directly, so you don't need to build between runs. Repeat until everything passes, then build once more (`doctor` warns when the build is out of date). If a question really has no answer in the content, that's a content gap: tell the owner and remove the check. Don't point it at an unrelated section.

## 10. Run `doctor` until it's green

```sh
pocket-rag doctor
```

This checks:
- that the config and content are sound and the build is up to date;
- that the output folder is published and every page loads the widget as a module;
- that the CSP allows it;
- the proxy settings, the privacy link, and that no API key is in the site;
- that the checks pass.

Each problem comes with its fix. Fix every ✖. Look at every !, and fix it or tell the owner why it's fine. `--json` gives the same as data.

If the config isn't in the site's root, pass it: `pocket-rag doctor --config assistant/pocket-rag.config.json`.

## 11. Try it in a browser

Serve the site the way it's normally previewed (`npm run dev`, `hugo server`, `npx serve .`, …) and open a page:
- the "Ask" button appears in the bottom-right corner;
- in own-key mode, clicking it shows a form for the visitor's API key. That's correct; don't enter a key.
- the browser console shows no errors about `pocket-rag`, CSP or MIME types.

If the site can't be served here (dependencies not installed, no dev server), skip this step, rely on `doctor`, and tell the owner to check it on their next preview. The owner can try a real question with their own key afterwards.

## 12. Keep it up to date

The knowledge base is a snapshot of the content. Rebuild whenever the content changes:

- **If the site has a `package.json` with a build script,** make the build run pocket-rag first.
  - **Installed as a dev dependency (step 1):**

    ```json
    "scripts": { "prebuild": "pocket-rag build && pocket-rag check" }
    ```

  - **Without the dev dependency,** use the full command in the script instead: `npx --yes github:sir-Disappointing/pocket-rag#v0.3.0 build`.

  `prebuild` runs before `npm run build` only. If the dev server (`npm start`, `npm run dev`) should pick up changes too, add the same line as `prestart` or `predev`. Tell the owner to run `npm install` once.
- **If the site has no build script,** rebuild by hand after content changes.
- **Commit the output folder or not?** Look at how the site is published:
  - if a host or CI runs `npm run build` (Netlify, Vercel, Cloudflare Pages, a GitHub Actions workflow), the output can go in `.gitignore`;
  - if the repository's files are published as they are (GitHub Pages without a workflow, plain hosting), commit it.
  - When unsure, commit it.
- **With a proxy,** also run `npx wrangler deploy` in `worker/` after a rebuild.

## 13. Tell the owner what you did

Summarize briefly:
- the files you added or changed;
- the payment mode, and for a proxy, the steps that are theirs (`wrangler` and the spending limit);
- how many checks pass;
- how to rebuild after content changes;
- that answers come from Claude and can be wrong. The widget says so too.
- **Costs:** with Claude Haiku, about $0.0003–0.0005 per question.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| No button | Script tag missing, wrong path (base path!), or not `type="module"` | `pocket-rag doctor`; check the browser console for a 404 on `widget.js` |
| Console: `settings.json` 404 | The output folder isn't published | Set `out` inside the published folder (`public/`, `static/`, …) and build again |
| Console: "Refused to connect" / CSP | `connect-src` doesn't allow Anthropic or the proxy | Step 6 |
| Console: MIME type error | The server sends `.js` with a wrong type | Serve the output folder as static files; don't route it through the app |
| "Can't reach the assistant" in the chat | CSP, network, or a wrong `proxyUrl` | Browser console; `pocket-rag doctor` |
| "API key isn't valid" | The visitor's key is wrong or has no credit | "Change key" in the chat |
| Off-topic or vague answers | The search sends the wrong sections | `pocket-rag ask "…"`, then step 9 |
| The assistant answers questions it shouldn't | `scope` is too wide or empty | Set `scope` (step 2) |

More detail on every option is in the [README](https://github.com/sir-Disappointing/pocket-rag#readme).
