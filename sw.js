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
 * (we ask again — the page may hold a newer one — and retry once). Nothing here
 * can renew an expired token: that needs Google's popup, which only a tap can
 * open. So the page answers with its cached token, or waits on a renewal popup
 * a tap already opened; failing that we 401 and tell the page a tap is needed.
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

/** Ask every open page for a token at once over MessageChannels; first usable answer wins. */
async function askClients() {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
  if (!clients.length) return null
  return new Promise((resolve) => {
    let left = clients.length
    // Pages with nothing to give reply null at once; a page waiting on a renewal
    // popup the user is still completing replies when it lands, so allow time.
    const timer = setTimeout(() => resolve(null), 90000)
    const answer = (tok) => {
      if (tok && tok.value) { clearTimeout(timer); resolve(tok) }
      else if (--left === 0) { clearTimeout(timer); resolve(null) }
    }
    for (const client of clients) {
      const ch = new MessageChannel()
      ch.port1.onmessage = (ev) => answer(ev.data)
      try {
        client.postMessage({ type: 'sbb-token-request' }, [ch.port2])
      } catch {
        answer(null)
      }
    }
  })
}

/** A usable token value — ours, or (when missing/stale/rejected) one pulled from the page. */
async function ensureToken(skipCache) {
  if (!skipCache && valid()) return token.value
  const tok = await askClients()
  token = tok && tok.value ? tok : null
  return token ? token.value : null
}

/** Tell open pages a tap is needed to renew sign-in, and fail this request. */
async function authRequired() {
  const clients = await self.clients.matchAll({ type: 'window' })
  for (const client of clients) client.postMessage({ type: 'sbb-auth-required' })
  return new Response('auth-required', { status: 401 })
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
  if (!value) return authRequired()

  const range = request.headers.get('Range')
  let res = await driveMedia(id, range, value)

  // 401 = token rejected (expired or revoked). Ask the page again — it may hold a
  // newer one — and retry once. A 403 is a Drive refusal (e.g. a quota limit),
  // not a sign-in problem, so it falls through as a plain error below.
  if (res.status === 401) {
    value = await ensureToken(true)
    if (!value) return authRequired()
    res = await driveMedia(id, range, value)
    if (res.status === 401) return authRequired()
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
