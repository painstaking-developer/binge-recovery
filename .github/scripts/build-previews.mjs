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
 *   PREVIEWS_SITE  site root that gets the e/ folder   (default: app/dist)
 *   PREVIEWS_JSON  source Recovery.json to read        (default: app/public/Recovery.json)
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
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
let count = 0

// Walk the tree carrying the folder trail (excluding the root) as context; that
// trail (+ year) becomes each talk's preview description.
;(function walk(node, trail, depth) {
  if (node.type === 'folder') {
    const next = depth === 0 ? [] : [...trail, node.name].filter(Boolean)
    for (const child of node.children || []) walk(child, next, depth + 1)
  } else if (node.type === 'file' && node.id) {
    const year = node.createdTime ? String(node.createdTime).slice(0, 4) : ''
    const desc = [trail.join(' · '), year].filter(Boolean).join(' · ') || SITE
    writeFileSync(join(eDir, `${node.id}.html`), page(node.id, node.name || 'Talk', desc))
    count++
  }
})(tree, [], 0)

console.log(`✓ build-previews: wrote ${count} episode preview pages to ${eDir}`)
