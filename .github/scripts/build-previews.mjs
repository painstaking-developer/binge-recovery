/**
 * build-previews.mjs — generate one tiny static HTML page per talk so that
 * shared links get a *per-episode* preview card.
 *
 * Why this is needed: the app is a hash-routed SPA (#/episode/<id>). Link-preview
 * crawlers (iMessage, WhatsApp, Slack, Twitter…) don't run JavaScript and never
 * see the URL fragment, so every shared link would otherwise unfurl with the one
 * static index.html's site-wide title ("Binge Recovery"). These pages
 * give each talk a real URL (`/e/<id>.html`) carrying its own <title>/og:* tags,
 * then instantly redirect real visitors into the SPA at the right episode.
 *
 * Two callers, one script (paths overridable by env so there's no second copy):
 *   1. Local `npm run build` — runs as `postbuild` with the defaults below, so the
 *      pages land in app/dist/e/ for `npm run dev`/`preview` and a from-source deploy.
 *   2. The PUBLIC repo's Pages workflow — build:public can't prerender these (it runs
 *      vite with --ignore-scripts, and 55k tiny files shouldn't be committed), so
 *      build-public.mjs ships THIS script + a workflow into out/ that regenerates the
 *      pages on GitHub's runner at deploy time, reading the slim Recovery.json at the
 *      site root. That run sets PREVIEWS_SITE=. and PREVIEWS_JSON=Recovery.json.
 *
 * The redirect target is RELATIVE ("../#/episode/<id>"), so it resolves correctly
 * whether the site is served from "/" or a project subpath "/<repo>/".
 *
 * Env overrides:
 *   PREVIEWS_SITE         site root that gets the e/ folder   (default: app/dist)
 *   PREVIEWS_JSON         source Recovery.json to read        (default: app/public/Recovery.json)
 *   PREVIEWS_CONCURRENCY  max writes in flight at once         (default: 128)
 */
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appDir = join(__dirname, '..')
const siteDir = resolve(process.env.PREVIEWS_SITE || join(appDir, 'dist'))
const srcJson = resolve(process.env.PREVIEWS_JSON || join(appDir, 'public', 'Recovery.json'))
const SITE = 'Binge Recovery'

if (!existsSync(siteDir)) { console.error(`✖ build-previews: site dir not found: ${siteDir}`); process.exit(1) }
if (!existsSync(srcJson)) { console.log(`• build-previews: no ${srcJson} — skipping`); process.exit(0) }

const escAttr = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function page(id, title, desc) {
  const t = escAttr(title)
  const d = escAttr(desc)
  const target = `../#/episode/${encodeURIComponent(id)}`
  const ta = escAttr(target)
  // og:* tags first (what crawlers read); the <script> redirect is for real
  // browsers (crawlers don't run it), with a meta-refresh fallback for no-JS.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<meta name="description" content="${d}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${escAttr(SITE)}">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<script>location.replace(${JSON.stringify(target)})</script>
<meta http-equiv="refresh" content="0;url=${ta}">
</head><body style="font-family:system-ui,sans-serif;margin:2rem;color:#202124">
<p>Opening <a href="${ta}">${t}</a> …</p>
</body></html>`
}

const eDir = join(siteDir, 'e')
rmSync(eDir, { recursive: true, force: true })
mkdirSync(eDir, { recursive: true })

const tree = JSON.parse(readFileSync(srcJson, 'utf8'))

// Phase 1 — walk the tree (cheap, in-memory) collecting one job per talk, carrying
// the folder trail (excluding the root) as context; that trail (+ year) becomes the
// preview description. We only collect here so the slow part (tens of thousands of
// disk writes) can run in parallel below instead of blocking the walk.
const jobs = []
;(function walk(node, trail, depth) {
  if (node.type === 'folder') {
    const next = depth === 0 ? [] : [...trail, node.name].filter(Boolean)
    for (const child of node.children || []) walk(child, next, depth + 1)
  } else if (node.type === 'file' && node.id) {
    const year = node.createdTime ? String(node.createdTime).slice(0, 4) : ''
    const desc = [trail.join(' · '), year].filter(Boolean).join(' · ') || SITE
    jobs.push({ id: node.id, title: node.name || 'Talk', desc })
  }
})(tree, [], 0)

// Phase 2 — drain the jobs through a bounded pool of async writes. The old version
// wrote files one at a time with writeFileSync, so each syscall blocked the next;
// disk writes overlap fine, so N workers pulling from a shared cursor keeps many in
// flight at once (a big speedup) without opening all ~55k handles at once (EMFILE).
const CONCURRENCY = Math.max(1, Number(process.env.PREVIEWS_CONCURRENCY) || 128)
let cursor = 0
async function worker() {
  while (cursor < jobs.length) {
    const j = jobs[cursor++]
    await writeFile(join(eDir, `${j.id}.html`), page(j.id, j.title, j.desc))
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker))

console.log(`✓ build-previews: wrote ${jobs.length} episode preview pages to ${eDir} (concurrency ${CONCURRENCY})`)
