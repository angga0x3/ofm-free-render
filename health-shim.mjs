#!/usr/bin/env node
/**
 * Health shim for Render.
 *
 * The OFM LAN relay only forwards the inference paths (models + chat/responses/
 * messages) and demands the LAN key on every one of them, so Render's
 * unauthenticated GET / would see 401 and mark the service unhealthy. This
 * shim listens on $PORT, answers the health check itself, and proxies everything
 * else to the relay — keeping the relay's auth intact for real traffic.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const PORT = Number(process.env.PORT || 10000)
const TARGET_PORT = Number(process.env.OFM_LAN_PORT || PORT + 1)
const DATA_DIR = process.env.OFM_HOME || '/data/ofm'
const HOST = '0.0.0.0'

function lanKey() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8'))
    return s.standaloneLanKey || ''
  } catch {
    return ''
  }
}

const server = http.createServer((req, res) => {
  const url = req.url || '/'
  const bare = url.split('?')[0]

  if (bare === '/health' || bare === '/') {
    const body = JSON.stringify({
      ok: true,
      service: 'ofm-free',
      upstream: `127.0.0.1:${TARGET_PORT}`,
      keyReady: lanKey() !== '',
    })
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    return res.end(body)
  }

  const headers = { ...req.headers, host: `127.0.0.1:${TARGET_PORT}` }
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
  console.log(`[health-shim] listening on ${HOST}:${PORT} → relay 127.0.0.1:${TARGET_PORT}`)
})
