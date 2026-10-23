# Working on pocket-rag

This file is for changing pocket-rag itself. **To add pocket-rag to a website, follow [SETUP.md](SETUP.md) instead.**

## Layout

- `bin/pocket-rag.mjs`: the CLI (`init`, `build`, `ask`, `check`, `doctor`).
- `src/retrieve.mjs`: the search (BM25, stemming, synonyms, keys). It runs in the browser and in the Worker, so it has no Node APIs and no dependencies.
- `src/lang/*.mjs`: per-language stopwords, word variants, instructions and UI texts.
- `src/build.mjs`: content → chunks (Markdown, MDX, HTML, JSON, text) and the build output.
- `src/detect.mjs`: framework, published folder, content folders, language and name.
- `src/diagnose.mjs`: `ask`, `check` (miss diagnosis and suggestions) and `doctor`.
- `widget/`: the browser widget (Shadow DOM, no dependencies). `worker/`: the Cloudflare Worker template.
- `example/`: the chess demo site, published to GitHub Pages by CI.

## Rules

- No runtime dependencies, anywhere. Node 20+ for the CLI; plain modern browsers for the widget.
- Every output that `doctor`, `check` or `ask` prints must also be available with `--json`, and every problem needs a concrete fix.
- Keep `SETUP.md`, `README.md` and `init`'s next steps in agreement when behaviour changes.

## Checks before a PR

```sh
npm test                                  # unit tests, no dependencies
npm run example                           # build + check the example (24 checks)
node test/e2e/browser.mjs                 # widget in Chromium (needs Playwright)
```
