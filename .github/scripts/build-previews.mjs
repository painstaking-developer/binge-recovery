/**
 * build-previews.mjs — generate one tiny static HTML page per talk so that
 * shared links get a *per-episode* preview card.
 *
 * Why this is needed: the app is a hash-routed SPA (#/e/<shortId>). Link-preview
 * crawlers (iMessage, WhatsApp, Slack, Twitter…) don't run JavaScript and never
 * see the URL fragment, so every shared link would otherwise unfurl with the one
 * static index.html's site-wide title ("Binge Recovery"). These pages give each
 * talk a real URL (`/e/<shortId>.html`) carrying its own <title>/og:* tags, then
 * instantly forward real visitors into the SPA at that talk.
 *
 * Privacy: a page holds the talk's NAME and nothing else. It's named by the
 * talk's short id (a one-way hash of the Drive id, src/lib/shortId.js), never the
 * Drive id, and carries no folder names — those stay behind the password. So
 * these are built whether or not the content vault is on.
 *
 * Sharing: the app's Share button links here with the talk's Drive id as `?d=`.
 * The page forwards that (plus the name) into the app — `#/e/<shortId>?d=…&t=…` —
 * which lets someone with no password play that one talk. Without `?d=` it
 * forwards to `#/e/<shortId>`, which opens only for a password that covers it.
 *
 * Two callers, one script (paths overridable by env so there's no second copy):
 *   1. Local `npm run build` — runs as `postbuild` with the defaults below, reading
 *      the plaintext Drive tree and writing app/dist/e/.
 *   2. The PUBLIC repo's Pages workflow — build:public can't prerender these (it runs
 *      vite with --ignore-scripts, and 55k tiny files shouldn't be committed), so
 *      build-public.mjs ships THIS script + a names-only previews.json (short id →
 *      talk name) + a workflow into out/, and the workflow regenerates the pages on
 *      GitHub's runner at deploy time.
 *
 * The forward target is RELATIVE ("../#/e/<shortId>"), so it resolves correctly
 * whether the site is served from "/" or a project subpath "/<repo>/".
 *
 * Env overrides:
 *   PREVIEWS_SITE         site root that gets the e/ folder   (default: app/dist)
 *   PREVIEWS_JSON         the Drive tree, or a { shortId: name } map
 *                                                             (default: app/public/Recovery.json)
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

function page(sid, title) {
  const t = escAttr(title)
  const target = `../#/e/${sid}`
  // og:* tags first (what crawlers read). The script forwards real browsers,
  // carrying a shared link's ?d= along; crawlers don't run it. The meta-refresh
  // is only for no-JS visitors — outside <noscript> it could fire after the
  // script's redirect and drop the ?d=.
  // `</` is escaped so a name can't close the <script> early.
  const fwd = `var d=new URLSearchParams(location.search).get('d');location.replace(${JSON.stringify(target)}+(d?'?d='+encodeURIComponent(d)+'&t='+encodeURIComponent(${JSON.stringify(title).replace(/</g, '\\u003c')}):''))`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<meta name="description" content="${escAttr(SITE)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${escAttr(SITE)}">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${escAttr(SITE)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${escAttr(SITE)}">
<script>${fwd}</script>
<noscript><meta http-equiv="refresh" content="0;url=${escAttr(target)}"></noscript>
</head><body style="font-family:system-ui,sans-serif;margin:2rem;color:#202124">
<p>Opening ${t} …</p>
</body></html>`
}

// The source is either the Drive tree (local build: hash it here, which also
// checks for short-id clashes) or the names-only map build-public ships.
const data = JSON.parse(readFileSync(srcJson, 'utf8'))
let titles
if (data.type === 'folder') {
  const { titlesByShortId } = await import('./preview-titles.mjs')
  try {
    titles = titlesByShortId(data)
  } catch (err) {
    console.error(`✖ build-previews: ${err.message}`)
    process.exit(1)
  }
} else {
  titles = data
}
const jobs = Object.entries(titles)
// Short ids are case-sensitive, like Pages' Linux filesystem. On Windows/macOS two
// that differ only by case would overwrite each other's page in a local build.
const folded = new Set(jobs.map(([sid]) => sid.toLowerCase()))
if (folded.size !== jobs.length) {
  console.warn(`! build-previews: ${jobs.length - folded.size} short id(s) differ only by case — their pages overwrite each other on a case-insensitive disk (fine on Pages)`)
}

const eDir = join(siteDir, 'e')
rmSync(eDir, { recursive: true, force: true })
mkdirSync(eDir, { recursive: true })

// Drain the jobs through a bounded pool of async writes: disk writes overlap
// fine, so N workers pulling from a shared cursor keeps many in flight at once
// without opening all ~55k handles at once (EMFILE).
const CONCURRENCY = Math.max(1, Number(process.env.PREVIEWS_CONCURRENCY) || 128)
let cursor = 0
async function worker() {
  while (cursor < jobs.length) {
    const [sid, title] = jobs[cursor++]
    await writeFile(join(eDir, `${sid}.html`), page(sid, title))
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker))

console.log(`✓ build-previews: wrote ${jobs.length} episode preview pages to ${eDir} (concurrency ${CONCURRENCY})`)
