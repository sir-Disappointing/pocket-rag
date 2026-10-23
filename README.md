# pocket-rag

A tiny "ask this site" assistant for static sites. Point it at your site's Markdown or HTML, and your visitors get a chat button that answers questions from that content, using Claude.

- **No vector database, no embeddings, no server you have to run.** A keyword search (BM25 with stemming and synonyms) picks the few pieces of content that fit each question. For a site of a few hundred pages that works well, and you can test it.
- **Cheap.** Each question sends a short core (cached) plus a handful of matching pieces, about 1–3k input tokens. Answers are kept short. With Claude Haiku that's well under a tenth of a cent per question.
- **Two ways to pay.** Visitors enter their own Anthropic API key, which stays in their browser. Or you deploy a small Cloudflare Worker that holds your key, with a rate limit, and set a spending limit on the key.
- **Drop-in.** One `<script type="module">` tag. The widget lives in a Shadow DOM, so your CSS can't break it and it can't break yours. Works under a strict Content Security Policy.
- **No dependencies.** The build, the widget and the Worker are plain JavaScript. The widget is about 18 KB (plus 17 KB of search code, loaded only when needed) and the Worker bundle about 32 KB.
- **English and Dutch** built in. Adding a language is one file.

It started as the "Vraag het" assistant on [Theorie Oefenen](https://github.com/sir-Disappointing/drive-alone), a free practice site for the Dutch driving theory exam.

## Set it up with your AI assistant

Paste this into Claude Code, Cursor, Copilot or any coding assistant, in your site's repository:

> Add pocket-rag to this site. Follow https://raw.githubusercontent.com/sir-Disappointing/pocket-rag/main/SETUP.md

The [setup guide](SETUP.md) takes it through every step, and asks you just one thing: whether visitors bring their own API key or you pay through a proxy. The CLI tells the assistant what to do next and checks the result:
- `init` detects your framework, published folder, content and language;
- `check` explains every search miss and suggests the fix;
- `doctor` checks the whole setup, from the script tag to your Content-Security-Policy.

## Quick start (by hand)

Requires Node 20 or newer.

```sh
cd your-site
npx github:sir-Disappointing/pocket-rag#v0.3.0 init     # looks at your site, writes pocket-rag.config.json and checks.json
# check the config: content folders, "about", "scope"
npx github:sir-Disappointing/pocket-rag#v0.3.0 build    # writes the widget into your site's published folder
npx github:sir-Disappointing/pocket-rag#v0.3.0 doctor   # checks the setup and says what's missing
```

Then add this to your pages (`init` prints the right line for your framework):

```html
<script type="module" src="pocket-rag/widget.js"></script>
```

Without a proxy, the widget asks visitors for their own API key. [SETUP.md](SETUP.md) covers privacy, theming, testing the search and keeping it up to date.

## Commands

| Command | What it does |
| --- | --- |
| `pocket-rag init` | Detects the framework (plain HTML, Hugo, Jekyll, Eleventy, Astro, Next.js, Vite, Docusaurus, VitePress, MkDocs), the published folder, content folders, language and name, and writes the config. |
| `pocket-rag build` | Builds the knowledge base and copies the widget into `out` (and the Worker's data into `worker`). |
| `pocket-rag ask "question"` | Shows the search terms, which sections a question gets with their scores and matched words, and words that appear nowhere in your content. `--previous "…"` for follow-ups. |
| `pocket-rag check` | Runs `checks.json`. For each miss it explains why (a word that's nowhere in the content, a section that ranks too low, a wrong id) and suggests the fix. |
| `pocket-rag doctor` | Checks the whole setup: content, core size, build up to date, output folder published, script tag present and a module, CSP, proxy, privacy link, API keys in the site, checks. Every problem comes with its fix. |

All commands take `--config <file>`. `ask`, `check`, `doctor` and `init` also take `--json` for machine-readable output. `check` and `doctor` exit with an error code on problems, so they work in CI.

**Live demo:** [sir-disappointing.github.io/pocket-rag](https://sir-disappointing.github.io/pocket-rag/) (the example below; bring your own API key).

To try the included example (a chess rules site) from a clone of this repo:

```sh
npm run example          # build and check example/
npx serve example/site   # or any static server, then open the page
```

## Content

Put your content in the folders listed under `content`; `node_modules`, build output and pocket-rag's own folders are skipped, and `"exclude"` leaves out more (paths relative to the config). Supported formats:

- **Markdown (`.md`, `.mdx`)**: every `##` (or deeper) heading becomes a separate piece. Its title is "Page title › Heading", and its id is `path/file#heading-slug` (or `#custom-id` with `## Heading {#custom-id}`). Text before the first `##` is a piece too. Long sections are split at paragraphs. In MDX, imports and components are dropped.
- **HTML (`.html`)**: the page's `<main>` (or `<article>`, or `<body>`) is split at `<h2>` and `<h3>`; navigation, header, footer, scripts and forms are left out. Ids use the headings' `id` attributes when they have one. So a plain HTML site can point `content` at its own pages.
- **JSON (`.json`)**: an array of `{ "id", "title", "text", "keys" }` (only `title` and `text` are required), or `{ "chunks": [...] }`. Handy for FAQs or anything you generate from a database.
- **Plain text (`.txt`)**: split at paragraphs, titled after the file name.

**Keys** are codes that should always find their piece when they appear in a question: a product number, a sign code, a rule number. In Markdown, add them as a comment in the section:

```md
## Castling
<!-- keys: O-O, O-O-O -->
```

Keys match without spaces and punctuation too, so `B6` also finds "b 6".

**Core files** (`core`) are always sent with every question, together with the instructions. Use them for a short summary of the most important facts. The core is cached by Anthropic, so it's cheap even when it's 1–2k tokens. Keep the rest in `content`.

## Configuration

`pocket-rag.config.json` (paths are relative to this file):

```jsonc
{
  "name": "Chess Rules Explained",          // required; used in the instructions
  "about": "a website that explains chess",  // optional, completes "You are the assistant of <name>, <about>"
  "scope": "the rules of chess",             // what it answers questions about; other topics are politely declined
  "lang": "en",                              // "en" or "nl": search rules and default texts

  "content": ["content"],                    // folders or files to search
  "exclude": ["content/drafts"],             // optional: leave these out
  "core": ["core.md"],                       // always sent (cached)
  "instructions": "instructions.md",         // optional: replace the default instructions (file or text)

  "stopwords": ["chess"],                    // words that are everywhere in your content, so they say nothing
  "synonyms": { "horse": ["knight"] },       // everyday word → words used in your content
  "phrases": { "who starts": ["moves first"] },  // multi-word phrase → search terms
  "tuning": { "maxChunks": 10, "maxChars": 7000, "minRatio": 0.3, "boost": { "guide/": 1.25 } },

  "out": "site/pocket-rag",                  // where the widget files go (next to your page)
  "worker": "worker",                        // optional: where to create the Cloudflare Worker
  "proxyUrl": "",                            // your Worker's address; empty = visitors use their own key

  "model": "claude-haiku-5-5",
  "maxTokens": 800,                          // answer length cap
  "effort": "low",
  "maxHistory": 12,                          // messages of the conversation that are sent along
  "maxQuestion": 2000,                       // characters
  "storageKey": "",                          // optional: localStorage key for the visitor's API key

  "ui": {                                    // any text in src/lang/<lang>.mjs → strings can be overridden here
    "welcome": "Hi! Ask me anything about the rules of chess.",
    "suggestions": ["How does castling work?"],
    "privacyUrl": "privacy.html"
  },
  "checks": "checks.json"
}
```

`tuning`:
- `maxChunks` and `maxChars` cap what is sent per question.
- `minRatio` drops pieces that score below that fraction of the best match.
- `boost` multiplies the score of pieces whose id starts with a prefix. Use it to prefer plain-language guides over reference text.

## Testing the search

`checks.json` lists questions and the piece ids you expect to come back (an id prefix works too):

```json
[
  { "q": "How does the horse move?", "expect": ["pieces#knight"] },
  { "q": "And can the king capture?", "previous": "How does the king move?", "expect": ["pieces#king", "pieces#capturing"] }
]
```

`pocket-rag check` reports every miss with what was found instead, why, and what to change, and exits with an error code, so you can run it in CI. The fix is usually a synonym (for a word that appears nowhere in your content), a phrase, a key, or a clearer heading. `pocket-rag ask "question"` shows the details of a single question.

## The widget

The build copies `widget.js`, `widget.css`, the search code and two JSON files into `out`:
- `settings.json` holds the texts and limits;
- `knowledge.json` holds the content, and is only loaded when a visitor with their own key asks a question.

**Theming:** set custom properties on the element from your own CSS:

```css
pocket-rag-widget {
  --pr-accent: #1a4fa0;         /* send button, your messages */
  --pr-accent-hover: #123a78;
  --pr-on-accent: #fff;
  --pr-fab: #16181d;            /* the floating button */
  --pr-font: "Inter", sans-serif;
  --pr-radius: 16px;
}
pocket-rag-widget { display: none; }   /* hide it, e.g. during a test */
```

All properties and their dark-mode values are at the top of `widget/widget.css`.

**From your page:** `window.pocketRag.open()`, `.close()` and `.ask("question")`, for example from your own "Ask about this" buttons.

**Content Security Policy:** the widget needs no `unsafe-inline`. It does need:

```
script-src 'self'; style-src 'self'; connect-src 'self' https://api.anthropic.com
```

If you use a proxy, add its address to `connect-src`.

## The proxy (optional)

With a proxy, visitors don't need a key and you pay. Set `"worker": "worker"` in the config and run `build`. It creates a Cloudflare Worker:

- **Origins:** it only accepts requests from the sites in `ALLOWED_ORIGINS`.
- **Rate limit:** 10 questions per minute per IP address.
- **Fixed settings:** it takes only the conversation from the browser and sets the model, instructions, sources and answer length itself, so nobody can use it as free general-purpose Claude access.
- **Streaming:** it passes the answer straight through to the browser.
- **No logs:** it doesn't log or store conversations.

Deploy it once (free Cloudflare account):

```sh
cd worker
npm install
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY    # paste the key; stored encrypted at Cloudflare
# set ALLOWED_ORIGINS in wrangler.toml to your site, e.g. "https://you.github.io"
npx wrangler deploy
```

Then set `proxyUrl` in the config to the address `deploy` printed, add it to your CSP's `connect-src`, and run `build` again. After content changes, run `build` and `npx wrangler deploy` again. The build only rewrites the Worker's data files (`knowledge.js`, `settings.js`, the search code). `src/index.js` and `wrangler.toml` are yours once created.

**Set a spending limit** on the key in the [Anthropic Console](https://console.anthropic.com) under Limits. That way a lot of traffic can never cost more than you chose.

## Cost

Rough numbers per question with Claude Haiku 5.5 ($0.10 / $0.50 per million input / output tokens):

| Part | Tokens | Cost |
| --- | --- | --- |
| Core (instructions + core files), cached after the first question | ~1,000 | ~$0.00001 |
| Matching sources and the question | ~500–2,000 | ~$0.0001 |
| Earlier conversation, cached | varies | small |
| Answer (capped at `maxTokens`) | ~200–400 | ~$0.0002 |

So roughly $0.0003 to $0.0005 per question: 2,000 to 3,000 questions per dollar. These are estimates; check real usage in the Anthropic Console. A core under 512 tokens isn't cached, but then it's cheap anyway.

## Privacy

When a visitor asks a question, it is sent to Anthropic (USA) together with the recent conversation and the matching pieces of your content. With their own key, it goes straight from their browser. With the proxy, Cloudflare sees their IP address for the rate limit. Nothing is stored by pocket-rag.

Tell your visitors. The widget shows a short notice and links to your privacy page (`ui.privacyUrl`). `example/site/privacy.html` is a starting point.

## Limits

- **Keyword search, not semantic search.** A question phrased very differently from your content can miss. Synonyms, phrases and `pocket-rag check` are how you deal with that. For thousands of pages, or questions in a different language than the content, embeddings will do better.
- **Claude can still be wrong.** The instructions tell it to answer only from the sources and to say when it doesn't know, but it's still an AI. The widget says so.
- **Every visitor sees the same content.** There is no per-user data.

## Adding a language

Copy `src/lang/en.mjs` to `src/lang/<code>.mjs`, translate the stopwords, word variants, instructions and texts, and add it to `LANGS` in `src/retrieve.mjs` and to `RUNTIME` in `src/build.mjs`.

## Development

```sh
npm test                    # unit tests: search, build, detection, check/doctor, Worker (no dependencies)
npm run example             # build and check the example
node test/e2e/browser.mjs   # browser test of the widget (needs Playwright)
```

## License

MIT
