/*
 * SandyBeachBinge audio streaming service worker (POC).
 *
 * Native <audio> can range-stream, but it won't attach an Authorization header
 * to its own requests — and Drive's media endpoint 403s without one (the
 * `access_token` query param is dead; only the Bearer header works, and it does
 * honor Range → 206). So we point <audio> at a SAME-ORIGIN url, intercept it
 * here, copy the Range header, add `Authorization: Bearer <token>`, and stream
 * the 206 back. No blob, no full-file download, token never in a url.
 *
 * Token handling: a worker can't read localStorage, so the page pushes the token
 * in (postMessage), AND we can pull one on demand over a MessageChannel — used
 * when the worker was restarted (lost its in-memory token) or when Drive 401s
 * mid-playback because the token expired (we ask the page to silently refresh,
 * then retry the range request once → seamless).
 *
 * Content-Range is synthesized from the chunk's Content-Length (CORS-safelisted,
 * so readable) plus a one-time `?fields=size` lookup, because Google does not
 * expose Content-Range to cross-origin readers.
 */

let token = null // { value, exp }
const sizeCache = new Map() // id -> { size, mimeType }

const API = 'https://www.googleapis.com/drive/v3/files/'
const MARKER = 'drive-audio/'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

// The page proactively pushes a fresh token before each play (fast path).
self.addEventListener('message', (e) => {
  const d = e.data
  if (d && d.type === 'sbb-token') token = { value: d.value, exp: d.exp }
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return
  const at = url.pathname.indexOf(MARKER)
  if (at === -1) return
  const id = url.pathname.slice(at + MARKER.length)
  if (id) event.respondWith(stream(id, event.request))
})

function valid() {
  return token && token.value && (!token.exp || token.exp > Date.now())
}

/** Ask each window client for a token over a MessageChannel; first valid wins. */
function askClient(client, forceRefresh) {
  return new Promise((resolve) => {
    const ch = new MessageChannel()
    // A forced (silent) refresh may hit the network; give it room. The cached
    // path replies instantly, so this timeout only bites on real failures.
    const timer = setTimeout(() => resolve(null), forceRefresh ? 8000 : 1500)
    ch.port1.onmessage = (ev) => { clearTimeout(timer); resolve(ev.data) }
    try {
      client.postMessage({ type: 'sbb-token-request', forceRefresh }, [ch.port2])
    } catch {
      clearTimeout(timer)
      resolve(null)
    }
  })
}

/** A usable token value, pulling from the page if ours is missing/stale. */
async function ensureToken(forceRefresh) {
  if (!forceRefresh && valid()) return token.value
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
  for (const client of clients) {
    const tok = await askClient(client, forceRefresh)
    if (tok && tok.value) { token = tok; return tok.value }
  }
  return null
}

function driveMedia(id, range, value) {
  const headers = { Authorization: `Bearer ${value}` }
  if (range) headers.Range = range
  return fetch(`${API}${id}?alt=media`, { headers })
}

async function meta(id, value) {
  let m = sizeCache.get(id)
  if (m) return m
  const r = await fetch(`${API}${id}?fields=size,mimeType`, { headers: { Authorization: `Bearer ${value}` } })
  if (!r.ok) return null
  const j = await r.json()
  m = { size: Number(j.size) || 0, mimeType: j.mimeType || 'audio/mpeg' }
  sizeCache.set(id, m)
  return m
}

async function stream(id, request) {
  let value = await ensureToken(false)
  if (!value) return new Response('auth-required', { status: 401 })

  const range = request.headers.get('Range')
  let res = await driveMedia(id, range, value)

  // Token likely expired mid-playback — force a fresh one from the page, retry once.
  if (res.status === 401 || res.status === 403) {
    token = null
    value = await ensureToken(true)
    if (!value) return new Response('auth-required', { status: 401 })
    res = await driveMedia(id, range, value)
    if (res.status === 401 || res.status === 403) return new Response('auth-required', { status: 401 })
  }
  if (res.status !== 200 && res.status !== 206) {
    return new Response('drive-error', { status: res.status })
  }

  const m = await meta(id, value)
  const len = Number(res.headers.get('Content-Length')) // safelisted → readable
  const total = m && m.size ? m.size : undefined
  const out = new Headers()
  out.set('Content-Type', res.headers.get('Content-Type') || (m && m.mimeType) || 'audio/mpeg')
  out.set('Accept-Ranges', 'bytes')
  if (Number.isFinite(len)) out.set('Content-Length', String(len))

  let status = 200
  if (range && res.status === 206) {
    const mm = /bytes=(\d+)-(\d*)/.exec(range)
    const start = mm ? Number(mm[1]) : 0
    const end = Number.isFinite(len) ? start + len - 1 : total ? total - 1 : start
    out.set('Content-Range', `bytes ${start}-${end}/${total || '*'}`)
    status = 206
  }

  // Pass the body stream straight through — true progressive streaming.
  return new Response(res.body, { status, headers: out })
}
