#!/usr/bin/env node
/**
 * Public gateway shim for Render.
 *
 * Render's health probe is an unauthenticated GET and the OFM relay answers 401
 * to everything it does not recognise, so the probe has to be answered here.
 * The relay also only exposes the loopback service's LAN key, which is re-minted
 * on every boot when there is no disk — so the caller presents `OFM_CLIENT_KEY`
 * and this shim swaps it for the current LAN key before forwarding.
 *
 * Revision notes (audit of the live deployment, 2026-11-23):
 *
 * - CORS. Preflight used to be answered by the auth check (401, no CORS
 *   headers), so no browser client could ever talk to this gateway. OPTIONS is
 *   now answered locally with a 204 and every response — including errors
 *   generated here — carries the CORS set.
 * - Auth. `x-goog-api-key` was advertised in `access-control-allow-headers` but
 *   rejected by the check. It is accepted now. `Bearer` is matched
 *   case-insensitively and the comparison is constant-time.
 * - Ordering. Auth runs before path matching, so an unauthenticated caller
 *   cannot enumerate which routes exist.
 * - Retries. A burst of six concurrent calls produced two 502s from the relay.
 *   Requests are buffered (bounded) and replayed on connect failure or 502/503
 *   while nothing has been written to the client yet.
 * - Dead models. The upstream listing advertises ids it then refuses with
 *   "Model does not support this protocol" (`jev-1.13-free` at the time of the
 *   audit). Such an id is remembered for `OFM_DEAD_MODEL_TTL_MS`, dropped from
 *   `/v1/models`, and answered with a clear error instead of a round trip.
 * - Hygiene. Hop-by-hop headers are stripped, the client's own `x-goog-api-key`
 *   is not forwarded, the upstream socket has a timeout, the request body is
 *   capped, and the internal relay port is no longer disclosed by `/health`.
 *
 * The LAN key is re-read on every request (cheap: a small JSON file, guarded by
 * an mtime check), so a key rotation on the service side is picked up without
 * restarting this process.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Transform } from 'node:stream'

const VERSION = '1.1.0'

const PORT = Number(process.env.PORT || 10000)
const TARGET_PORT = Number(process.env.OFM_RELAY_PORT || 18901)
const DATA_DIR = process.env.OFM_HOME || path.join(process.cwd(), 'ofm-data')
const CLIENT_KEY = (process.env.OFM_CLIENT_KEY || '').trim()
const HOST = '0.0.0.0'

const UPSTREAM_TIMEOUT_MS = Number(process.env.OFM_UPSTREAM_TIMEOUT_MS || 300_000)
const MAX_BODY_BYTES = Number(process.env.OFM_MAX_BODY_BYTES || 32 * 1024 * 1024)
const MAX_ATTEMPTS = Math.max(0, Number(process.env.OFM_RETRIES ?? 2))
const DEAD_TTL_MS = Number(process.env.OFM_DEAD_MODEL_TTL_MS || 30 * 60 * 1000)
const KEY_WAIT_MS = Number(process.env.OFM_KEY_WAIT_MS || 5_000)

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': [
    'authorization', 'content-type', 'x-api-key', 'x-goog-api-key', 'x-goog-api-client',
    'anthropic-version', 'anthropic-beta', 'anthropic-dangerous-direct-browser-access',
    'x-ofm-effort', 'x-request-id', 'x-stainless-lang', 'x-stainless-package-version',
    'x-stainless-os', 'x-stainless-arch', 'x-stainless-runtime',
    'x-stainless-runtime-version', 'x-stainless-retry-count', 'x-stainless-timeout',
  ].join(', '),
  'access-control-expose-headers': 'x-request-id, x-ofm-request-id, x-ofm-filtered, retry-after',
  'access-control-max-age': '600',
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

const AGENT = new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16 })

/* ------------------------------------------------------------------ settings */

let keyCache = { mtimeMs: -1, key: '' }

function lanKey() {
  const file = path.join(DATA_DIR, 'settings.json')
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    keyCache = { mtimeMs: -1, key: '' }
    return ''
  }
  if (stat.mtimeMs === keyCache.mtimeMs) return keyCache.key
  let key = ''
  try {
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof settings.standaloneLanKey === 'string') key = settings.standaloneLanKey
  } catch {}
  keyCache = { mtimeMs: stat.mtimeMs, key }
  return key
}

async function waitForKey() {
  const deadline = Date.now() + KEY_WAIT_MS
  for (;;) {
    const key = lanKey()
    if (key) return key
    if (Date.now() >= deadline) return ''
    await sleep(100)
  }
}

/* --------------------------------------------------------------- dead models */

const DEAD_FILE = path.join(DATA_DIR, 'dead-models.json')
const dead = new Map()

function loadDead() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DEAD_FILE, 'utf8'))
    const now = Date.now()
    for (const [id, until] of Object.entries(parsed)) {
      if (typeof until === 'number' && until > now) dead.set(id, until)
    }
  } catch {}
}

function persistDead() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(DEAD_FILE, JSON.stringify(Object.fromEntries(dead), null, 2), { mode: 0o600 })
  } catch {}
}

function isDead(id) {
  const until = dead.get(id)
  if (until === undefined) return false
  if (until > Date.now()) return true
  dead.delete(id)
  persistDead()
  return false
}

function markDead(id) {
  if (!id || dead.has(id)) return
  dead.set(id, Date.now() + DEAD_TTL_MS)
  persistDead()
  console.log(`[gateway] model ${id} marked unavailable for ${Math.round(DEAD_TTL_MS / 1000)}s`)
}

/* -------------------------------------------------------------------- helpers */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function requestId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16)
}

function send(res, status, payload, extra = {}) {
  if (res.headersSent || res.destroyed) return
  const body = Buffer.from(JSON.stringify(payload))
  res.writeHead(status, {
    ...CORS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...extra,
  })
  res.end(body)
}

function fail(res, status, type, message, extra = {}) {
  send(res, status, { error: { message, type, param: null, ...extra } })
}

function presentedKey(req) {
  const auth = req.headers.authorization
  if (typeof auth === 'string') {
    const match = /^bearer\s+(.+)$/i.exec(auth.trim())
    if (match) return match[1].trim()
  }
  for (const name of ['x-api-key', 'x-goog-api-key']) {
    const value = req.headers[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

function keyMatches(presented, expected) {
  if (presented === '' || expected === '') return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body too large'), { code: 'TOO_LARGE' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function bodyModel(body, headers) {
  const type = String(headers['content-type'] || '')
  if (!type.includes('json') || body.length === 0 || body.length > 1024 * 1024) return ''
  try {
    const parsed = JSON.parse(body.toString('utf8'))
    return typeof parsed?.model === 'string' ? parsed.model : ''
  } catch {
    return ''
  }
}

/** Passes bytes straight through while keeping a bounded copy for error inspection. */
class Peek extends Transform {
  constructor(limit) {
    super()
    this.limit = limit
    this.chunks = []
    this.size = 0
  }
  _transform(chunk, _encoding, callback) {
    if (this.size < this.limit) {
      this.chunks.push(chunk)
      this.size += chunk.length
    }
    callback(null, chunk)
  }
  text() {
    return Buffer.concat(this.chunks).subarray(0, this.limit).toString('utf8')
  }
}

function forwardHeaders(req, lanKeyValue) {
  const headers = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name)) continue
    if (name === 'authorization' || name === 'x-api-key' || name === 'x-goog-api-key') continue
    headers[name] = value
  }
  headers.host = `127.0.0.1:${TARGET_PORT}`
  headers.authorization = `Bearer ${lanKeyValue}`
  headers['x-ofm-gateway'] = `ofm-free/${VERSION}`
  return headers
}

/* --------------------------------------------------------------------- proxy */

function attemptRelay(req, res, ctx, body, lanKeyValue, lastAttempt) {
  return new Promise((resolve) => {
    const headers = forwardHeaders(req, lanKeyValue)
    if (body.length > 0) headers['content-length'] = body.length
    else delete headers['content-length']

    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      cleanupListeners()
      resolve(value)
    }

    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: TARGET_PORT,
        path: req.url,
        method: req.method,
        headers,
        agent: AGENT,
        timeout: UPSTREAM_TIMEOUT_MS,
      },
      (up) => {
        const status = up.statusCode || 502

        // Nothing has reached the client yet, so a saturated relay is retryable.
        if (!lastAttempt && (status === 502 || status === 503)) {
          up.resume()
          up.on('end', () => settle({ retry: true }))
          up.on('error', () => settle({ retry: true }))
          return
        }

        const outHeaders = { ...up.headers }
        for (const name of HOP_BY_HOP) delete outHeaders[name]
        Object.assign(outHeaders, CORS)
        outHeaders['x-request-id'] = ctx.id
        if (!outHeaders['cache-control']) outHeaders['cache-control'] = 'no-store'

        res.writeHead(status, outHeaders)
        ctx.wrote = true

        if (status >= 400) {
          const peek = new Peek(4096)
          peek.on('end', () => {
            const text = peek.text()
            if (status === 400 && /does not support this protocol/i.test(text)) {
              markDead(ctx.model)
            }
          })
          up.pipe(peek).pipe(res)
          up.on('end', () => settle({ retry: false }))
          up.on('error', () => settle({ retry: false }))
          return
        }

        up.pipe(res)
        up.on('end', () => settle({ retry: false }))
        up.on('error', () => settle({ retry: false }))
      },
    )

    // A client that walks away must not leave the upstream socket open: without
    // this the relay keeps generating tokens for nobody, and the promise below
    // never settles.
    const onResClose = () => {
      if (res.writableEnded) return
      upstream.destroy()
      settle({ retry: false })
    }
    const onReqAbort = () => upstream.destroy()
    res.once('close', onResClose)
    req.once('aborted', onReqAbort)
    function cleanupListeners() {
      res.removeListener('close', onResClose)
      req.removeListener('aborted', onReqAbort)
    }

    upstream.on('timeout', () => {
      upstream.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' }))
    })

    upstream.on('error', (error) => {
      if (ctx.wrote) {
        settle({ retry: false })
        if (!res.destroyed) res.destroy()
        return
      }
      if (!lastAttempt) return settle({ retry: true })
      console.error(`[gateway] relay error: ${error.code || error.message}`)
      fail(res, 502, 'upstream_error', `relay unreachable: ${error.code || error.message}`)
      settle({ retry: false })
    })

    if (body.length > 0) upstream.end(body)
    else upstream.end()
  })
}

async function relay(req, res, ctx, body, lanKeyValue) {
  for (let attempt = 0; attempt <= MAX_ATTEMPTS; attempt++) {
    const lastAttempt = attempt === MAX_ATTEMPTS
    const result = await attemptRelay(req, res, ctx, body, lanKeyValue, lastAttempt)
    if (!result.retry) return
    if (res.destroyed || res.writableEnded) return
    await sleep(150 * (attempt + 1) + Math.floor(Math.random() * 100))
  }
}

/* -------------------------------------------------------------------- models */

function modelsRequest(lanKeyValue, ctx) {
  return new Promise((resolve, reject) => {
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: TARGET_PORT,
        path: '/v1/models',
        method: 'GET',
        headers: {
          host: `127.0.0.1:${TARGET_PORT}`,
          authorization: `Bearer ${lanKeyValue}`,
          accept: 'application/json',
          'accept-encoding': 'identity',
          'x-ofm-gateway': `ofm-free/${VERSION}`,
          'x-request-id': ctx.id,
        },
        agent: AGENT,
        timeout: UPSTREAM_TIMEOUT_MS,
      },
      (up) => {
        const chunks = []
        up.on('data', (chunk) => chunks.push(chunk))
        up.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if ((up.statusCode || 500) >= 400) {
            return reject(Object.assign(new Error(text.slice(0, 200)), { status: up.statusCode }))
          }
          try {
            resolve(JSON.parse(text))
          } catch (error) {
            reject(error)
          }
        })
        up.on('error', reject)
      },
    )
    upstream.on('timeout', () => upstream.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' })))
    upstream.on('error', reject)
    upstream.end()
  })
}

async function listModels(req, res, ctx, lanKeyValue, includeAll) {
  let listing
  try {
    listing = await modelsRequest(lanKeyValue, ctx)
  } catch (error) {
    return fail(res, 502, 'upstream_error', `model listing failed: ${error.code || error.message}`)
  }
  const data = Array.isArray(listing?.data) ? listing.data : []
  const live = includeAll ? data : data.filter((model) => !isDead(model?.id))
  const filtered = data.length - live.length
  send(res, 200, { ...listing, data: live }, {
    'x-ofm-filtered': String(filtered),
    'cache-control': 'no-store',
  })
}

/* -------------------------------------------------------------------- server */

const ROUTES = new Set([
  '/v1/models', '/v1/chat/completions', '/v1/responses',
  '/v1/messages', '/v1/messages/count_tokens',
])

function normalise(url) {
  const [pathname, search = ''] = url.split('?')
  const bare = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  return { bare, query: new URLSearchParams(search) }
}

function healthPayload() {
  const key = lanKey()
  const uptime = process.uptime()
  return {
    ok: true,
    service: 'ofm-free',
    version: VERSION,
    keyReady: CLIENT_KEY !== '',
    relayReady: key !== '',
    deadModels: dead.size,
    uptime: Math.round(uptime),
  }
}

const KEY_GRACE_MS = Number(process.env.OFM_KEY_GRACE_MS || 60_000)

const server = http.createServer(async (req, res) => {
  const ctx = { id: requestId(), wrote: false, model: '' }
  const { bare, query } = normalise(req.url || '/')

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...CORS, 'content-length': '0' })
    return res.end()
  }

  if (bare === '/health' || bare === '/') {
    const payload = healthPayload()
    // `?strict=1` fails the moment the relay key is gone. The default keeps a
    // grace window so a cold start is not killed before the service mints its
    // LAN key. After the grace window a dead relay fails the probe, so Render
    // restarts the instance instead of leaving one that answers 502 forever.
    // A missing OFM_CLIENT_KEY is a permanent misconfiguration, not a crash:
    // it is reported as `keyReady:false` and every API call answers 503, but the
    // probe stays green — a restart loop would only bury the real cause in logs.
    const graceExpired = process.uptime() * 1000 > KEY_GRACE_MS
    const unhealthy = !payload.relayReady && (graceExpired || query.get('strict') === '1')
    return send(res, unhealthy ? 503 : 200, { ...payload, ok: !unhealthy }, { 'x-request-id': ctx.id })
  }

  // Auth first: an anonymous caller should not learn which routes exist.
  if (!CLIENT_KEY) {
    return fail(res, 503, 'config_error', 'OFM_CLIENT_KEY is not set on this service')
  }
  if (!keyMatches(presentedKey(req), CLIENT_KEY)) {
    return fail(res, 401, 'unauthorized', 'bad client key')
  }

  const route = bare === '/models' ? '/v1/models' : bare
  if (!ROUTES.has(route)) {
    return fail(res, 404, 'not_found', `no route for ${req.method} ${bare}`)
  }

  const lanKeyValue = await waitForKey()
  if (!lanKeyValue) {
    return fail(res, 503, 'config_error', 'relay key not ready')
  }

  if (route === '/v1/models' && (req.method === 'GET' || req.method === 'HEAD')) {
    return listModels(req, res, ctx, lanKeyValue, query.get('all') === '1')
  }

  let body
  try {
    body = await readBody(req)
  } catch (error) {
    return fail(res, error.code === 'TOO_LARGE' ? 413 : 400, 'invalid_request_error',
      error.code === 'TOO_LARGE' ? 'request body too large' : error.message)
  }

  ctx.model = bodyModel(body, req.headers)
  if (ctx.model && isDead(ctx.model)) {
    return fail(res, 400, 'invalid_request_error',
      `model "${ctx.model}" is not available on this lane: the upstream rejects the protocol`,
      { code: 'CLIENT_ERROR' })
  }

  req.on('close', () => {
    if (!res.writableEnded) res.destroy()
  })

  await relay(req, res, ctx, body, lanKeyValue)
})

loadDead()

server.listen(PORT, HOST, () => {
  console.log(`[gateway] ${HOST}:${PORT} → relay 127.0.0.1:${TARGET_PORT} | v${VERSION} | client key ${CLIENT_KEY ? 'pinned' : 'MISSING'}`)
  console.log(`[gateway] data ${DATA_DIR} | lan key ${lanKey() ? 'present' : 'pending'} | dead models ${dead.size}`)
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 5_000).unref()
  })
}
