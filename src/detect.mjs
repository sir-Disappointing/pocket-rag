// Looks at a site's folder and works out what kind of site it is: where static files are served from,
// where the shared page layout is, where the content lives, the language and the name.
// `pocket-rag init` writes its config from this, `pocket-rag doctor` uses it to check the setup.
import fs from "node:fs";
import path from "node:path";
import { LANGS } from "./retrieve.mjs";

const exists = (dir, ...names) => names.find((n) => fs.existsSync(path.join(dir, n)));
const read = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

// Per framework: how to recognise it, where static files go, and how to add the script tag.
// `publicDir` is relative to the project; the widget goes in `<publicDir>/pocket-rag`.
const FRAMEWORKS = [
  {
    id: "docusaurus",
    name: "Docusaurus",
    match: (d) => exists(d, "docusaurus.config.js", "docusaurus.config.ts", "docusaurus.config.mjs"),
    publicDir: "static",
    content: ["docs", "blog"],
    script: 'In docusaurus.config: `scripts: [{ src: "/pocket-rag/widget.js", type: "module" }]` (prefix with your baseUrl if it isn\'t "/").',
  },
  {
    id: "vitepress",
    name: "VitePress",
    match: (d) => exists(d, ".vitepress", "docs/.vitepress"),
    publicDir: (d) => (exists(d, "docs/.vitepress") ? "docs/public" : "public"),
    content: (d) => (exists(d, "docs/.vitepress") ? ["docs"] : ["."]),
    script: "In .vitepress/config: `head: [['script', { type: 'module', src: '/pocket-rag/widget.js' }]]` (prefix with your base if it isn't \"/\").",
  },
  {
    id: "astro",
    name: "Astro",
    match: (d) => exists(d, "astro.config.mjs", "astro.config.js", "astro.config.ts"),
    publicDir: "public",
    content: ["src/content", "src/pages"],
    layout: ["src/layouts"],
    script: 'In your base layout (src/layouts/…), before </body>: `<script is:inline type="module" src="/pocket-rag/widget.js"></script>`. `is:inline` stops Astro from bundling it.',
  },
  {
    id: "next",
    name: "Next.js",
    match: (d) => exists(d, "next.config.js", "next.config.mjs", "next.config.ts"),
    publicDir: "public",
    content: ["content", "docs", "posts", "app", "pages"],
    layout: ["app/layout.tsx", "app/layout.jsx", "app/layout.js", "pages/_document.tsx", "pages/_document.jsx", "pages/_document.js", "src/app/layout.tsx", "src/pages/_document.tsx"],
    script: 'In the root layout (app/layout) or pages/_document, inside <body>: `<script type="module" src="/pocket-rag/widget.js" async></script>`. A plain <script> tag; next/script is not needed.',
  },
  {
    id: "hugo",
    name: "Hugo",
    match: (d) => exists(d, "hugo.toml", "hugo.yaml", "hugo.json") || (exists(d, "config.toml") && exists(d, "content") && exists(d, "layouts", "themes")),
    publicDir: "static",
    content: ["content"],
    layout: ["layouts/_default/baseof.html", "layouts/partials"],
    script: 'In layouts/_default/baseof.html (copy it from your theme if needed) before </body>: `<script type="module" src="{{ "pocket-rag/widget.js" | relURL }}"></script>`.',
  },
  {
    id: "jekyll",
    name: "Jekyll",
    match: (d) => exists(d, "_config.yml", "_config.yaml"),
    publicDir: ".",
    content: ["_posts", "_docs", "docs", "."],
    layout: ["_layouts/default.html", "_includes"],
    script: 'In _layouts/default.html before </body>: `<script type="module" src="{{ "/pocket-rag/widget.js" | relative_url }}"></script>`.',
  },
  {
    id: "eleventy",
    name: "Eleventy",
    match: (d) => exists(d, ".eleventy.js", "eleventy.config.js", "eleventy.config.mjs", "eleventy.config.cjs"),
    publicDir: ".",
    content: ["src", "content", "posts", "."],
    layout: ["_includes", "src/_includes"],
    script: 'In your base layout (_includes/…) before </body>: `<script type="module" src="/pocket-rag/widget.js"></script>`. Also add `eleventyConfig.addPassthroughCopy("pocket-rag")` (with the same path as "out"), or the files won\'t be published.',
  },
  {
    id: "mkdocs",
    name: "MkDocs",
    match: (d) => exists(d, "mkdocs.yml", "mkdocs.yaml"),
    publicDir: "docs",
    content: ["docs"],
    script: "In mkdocs.yml: `extra_javascript: [{ path: pocket-rag/widget.js, type: module }]` (MkDocs 1.5+).",
  },
  {
    id: "vite",
    name: "Vite",
    match: (d) => exists(d, "vite.config.js", "vite.config.ts", "vite.config.mjs"),
    publicDir: "public",
    content: ["src", "docs", "content"],
    layout: ["index.html"],
    script: 'In index.html before </body>: `<script type="module" src="/pocket-rag/widget.js"></script>`. Files in public/ are copied as they are, so Vite leaves the widget alone.',
  },
  {
    id: "static",
    name: "plain static site",
    match: (d) => exists(d, "index.html", "public/index.html", "docs/index.html", "site/index.html"),
    publicDir: (d) => (exists(d, "index.html") ? "." : path.dirname(exists(d, "public/index.html", "docs/index.html", "site/index.html"))),
    content: (d) => [exists(d, "index.html") ? "." : path.dirname(exists(d, "public/index.html", "docs/index.html", "site/index.html"))],
    layout: ["index.html"],
    script: 'In every HTML page (or your shared template) before </body>: `<script type="module" src="pocket-rag/widget.js"></script>`. Use a path relative to the page, or a root path like "/pocket-rag/widget.js" if the site is at the domain root.',
  },
];

const val = (v, dir) => (typeof v === "function" ? v(dir) : v);

const SKIP = new Set(["node_modules", ".git", "dist", "build", "_site", "out", ".next", ".astro", "public", "static", "coverage", "vendor", "pocket-rag", "worker",
  // templates, not content
  "layouts", "_layouts", "_includes", "includes", "partials", "themes", "components", "templates", "theme", "assets"]);
const CONTENT_EXT = new Set([".md", ".markdown", ".mdx", ".html", ".htm"]);

// Folders with the most Markdown/HTML, as candidates for "content".
function contentCandidates(dir, preferred) {
  const counts = new Map();
  const visit = (d, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name.startsWith("_site")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) visit(p, depth + 1);
      } else if (CONTENT_EXT.has(path.extname(e.name).toLowerCase())) {
        const rel = path.relative(dir, d) || ".";
        const top = rel === "." ? "." : rel.split(path.sep)[0];
        counts.set(top, (counts.get(top) || 0) + 1);
      }
    }
  };
  // The framework's usual content folders first (they can be deeper, like src/content).
  const fromPreferred = [];
  for (const p of preferred.filter((p) => p !== ".")) {
    const before = new Map(counts);
    counts.clear();
    visit(path.join(dir, p), 0);
    const files = [...counts.values()].reduce((a, b) => a + b, 0);
    counts.clear();
    for (const [k, v] of before) counts.set(k, v);
    if (files) fromPreferred.push({ folder: p, files });
  }
  if (fromPreferred.length) return fromPreferred;
  visit(dir, 0);
  return [...counts].map(([folder, files]) => ({ folder, files })).sort((a, b) => b.files - a.files);
}

function firstHtml(dir, publicDir) {
  for (const f of ["index.html", path.join(publicDir, "index.html"), "src/index.html", "docs/index.html"]) {
    const t = read(path.join(dir, f));
    if (t) return { file: f, text: t };
  }
  return null;
}

function siteName(dir, html, layouts) {
  const titleOf = (text) => {
    const t = (text.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1];
    return t && !/[{}]/.test(t) ? t.split(/\s[|–—-]\s/)[0].trim() : null;
  };
  const fromHtml = html && titleOf(html.text);
  if (fromHtml) return fromHtml;
  for (const f of ["hugo.toml", "config.toml", "_config.yml", "mkdocs.yml", "docusaurus.config.js", "docusaurus.config.ts", "docusaurus.config.mjs", ".vitepress/config.js", ".vitepress/config.mts", "docs/.vitepress/config.js", "docs/.vitepress/config.mts"]) {
    const m = read(path.join(dir, f)).match(/\b(?:title|site_name)\s*[:=]\s*["']([^"'\n]+)["']/) || read(path.join(dir, f)).match(/^\s*(?:title|site_name)\s*:\s*([^\n#]+)/m);
    if (m) return m[1].trim();
  }
  for (const l of layouts) {
    const p = path.join(dir, l);
    const files = fs.existsSync(p) && fs.statSync(p).isDirectory() ? fs.readdirSync(p).map((f) => path.join(p, f)) : [p];
    for (const f of files) {
      const t = titleOf(read(f));
      if (t) return t;
    }
  }
  const pkg = read(path.join(dir, "package.json"));
  if (pkg) {
    try {
      const name = JSON.parse(pkg).name;
      if (name) return name;
    } catch {}
  }
  return path.basename(path.resolve(dir));
}

function siteLang(dir, html) {
  const fromHtml = html && (html.text.match(/<html[^>]*\blang=["']?([a-zA-Z-]+)/i) || [])[1];
  const fromConfig = ["hugo.toml", "config.toml", "_config.yml", "mkdocs.yml"]
    .map((f) => (read(path.join(dir, f)).match(/^\s*(?:languageCode|defaultContentLanguage|lang|language)\s*[:=]\s*["']?([a-zA-Z-]+)/m) || [])[1])
    .find(Boolean);
  const raw = (fromHtml || fromConfig || "en").toLowerCase().split("-")[0];
  return { found: raw, lang: LANGS[raw] ? raw : "en", supported: Boolean(LANGS[raw]) };
}

export function detect(dir = ".") {
  const fw = FRAMEWORKS.find((f) => f.match(dir)) || { id: "unknown", name: "unknown", publicDir: ".", content: ["."], script: FRAMEWORKS.at(-1).script };
  const publicDir = val(fw.publicDir, dir) || ".";
  const html = firstHtml(dir, publicDir);
  const preferred = val(fw.content, dir) || [];
  const candidates = contentCandidates(dir, preferred);
  const lang = siteLang(dir, html);
  const layouts = (fw.layout || []).filter((f) => fs.existsSync(path.join(dir, f)));
  return {
    framework: fw.id,
    frameworkName: fw.name,
    publicDir,
    out: path.join(publicDir, "pocket-rag").split(path.sep).join("/"),
    content: candidates.length ? candidates.slice(0, 3).map((c) => c.folder) : preferred.slice(0, 1),
    candidates,
    layouts,
    script: fw.script,
    name: siteName(dir, html, layouts),
    lang: lang.lang,
    langFound: lang.found,
    langSupported: lang.supported,
  };
}

// Files that can hold the script tag or a Content-Security-Policy.
const PAGE_EXT = new Set([".html", ".htm", ".njk", ".liquid", ".hbs", ".astro", ".tsx", ".jsx", ".js", ".mjs", ".ts", ".vue", ".svelte", ".erb", ".php", ".md", ".mdx", ".yml", ".yaml", ".toml", ".json"]);
const HEADER_FILES = new Set(["_headers", "netlify.toml", "vercel.json", "firebase.json", "staticwebapp.config.json", ".htaccess"]);

export function sourceFiles(dir, skipAbs = []) {
  const out = [];
  const visit = (d, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith(".") && e.name !== ".vitepress") continue;
        if (["node_modules", "dist", "build", "_site", "out", ".next", ".astro", "coverage"].includes(e.name) || skipAbs.includes(p)) continue;
        visit(p, depth + 1);
      } else if (PAGE_EXT.has(path.extname(e.name).toLowerCase()) || HEADER_FILES.has(e.name)) {
        out.push(p);
      }
    }
  };
  visit(dir, 0);
  return out;
}
