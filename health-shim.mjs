#!/usr/bin/env node
/**
 * Public gateway shim for Render.
 *
 * Three problems this solves, all of them Render-shaped:
 *
 * 1. Render's health probe is an unauthenticated GET, and the OFM relay answers
 *    401 to everything it forwards — so the probe has to be answered here.
 * 2. Free tier has no persistent disk, so the relay mints a fresh random LAN key
 *    on every boot. A key that changes per deploy is unusable for a client, so
 *    the caller presents `OFM_CLIENT_KEY` and this shim swaps it for the current
 *    LAN key before forwarding.
 * 3. The relay only forwards inference paths; `/health` is answered locally.
 *
 * The LAN key is re-read on every request (cheap: a small JSON file), so a key
 * rotation on the service side is picked up without restarting this process.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const PORT = Number(process.env.PORT || 10000)
const TARGET_PORT = Number(process.env.OFM_RELAY_PORT || 18901)
const DATA_DIR = process.env.OFM_HOME || '/data/ofm'
const CLIENT_KEY = process.env.OFM_CLIENT_KEY || ''
const HOST = '0.0.0.0'

function lanKey() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8'))
    return s.standaloneLanKey || ''
  } catch {
    return ''
  }
}

function bearer(req) {
  const h = req.headers.authorization || ''
  if (h.startsWith('Bearer ')) return h.slice(7).trim()
  return (req.headers['x-api-key'] || '').trim()
}

const server = http.createServer((req, res) => {
  const url = req.url || '/'
  const bare = url.split('?')[0]

  if (bare === '/health' || bare === '/') {
    const body = JSON.stringify({
      ok: true,
      service: 'ofm-free',
      upstream: `127.0.0.1:${TARGET_PORT}`,
      keyReady: CLIENT_KEY !== '',
    })
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    return res.end(body)
  }

  // Only inference paths are public; management stays loopback-only by design.
  const allowed = /^\/(v1\/)?(models|chat\/completions|responses|messages|messages\/count_tokens)$/
  if (!allowed.test(bare)) {
    const body = JSON.stringify({ error: { type: 'not_found', message: url } })
    res.writeHead(404, { 'content-type': 'application/json' })
    return res.end(body)
  }

  const presented = bearer(req)
  if (!CLIENT_KEY || presented !== CLIENT_KEY) {
    const body = JSON.stringify({ error: { type: 'unauthorized', message: 'bad client key' } })
    res.writeHead(401, { 'content-type': 'application/json' })
    return res.end(body)
  }

  const key = lanKey()
  if (!key) {
    const body = JSON.stringify({ error: { type: 'config_error', message: 'relay key not ready' } })
    res.writeHead(503, { 'content-type': 'application/json' })
    return res.end(body)
  }

  const headers = {
    ...req.headers,
    host: `127.0.0.1:${TARGET_PORT}`,
    authorization: `Bearer ${key}`,
  }
  delete headers['x-api-key']

  const upstream = http.request(
    { host: '127.0.0.1', port: TARGET_PORT, path: url, method: req.method, headers },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers)
      up.pipe(res)
    },
  )
  upstream.on('error', (e) => {
    if (!res.headersSent) {
      const body = JSON.stringify({ error: { type: 'upstream_error', message: e.message } })
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(body)
    }
  })
  req.pipe(upstream)
})

server.listen(PORT, HOST, () => {
  console.log(`[gateway] ${HOST}:${PORT} → relay 127.0.0.1:${TARGET_PORT} | client key ${CLIENT_KEY ? 'pinned' : 'MISSING'}`)
})
