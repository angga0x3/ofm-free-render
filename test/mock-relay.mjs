/**
 * Mock relay for exercising health-shim.mjs locally.
 *
 * Reproduces the two behaviours the audit found on the real deployment:
 * - a burst of concurrent calls returns 502 (upstream saturation);
 * - one model id answers 400 "Model does not support this protocol".
 */
import http from 'node:http'

const PORT = Number(process.env.MOCK_PORT || 18901)
const LAN_KEY = process.env.MOCK_LAN_KEY || 'lan-secret'
const MAX_CONCURRENT = Number(process.env.MOCK_MAX_CONCURRENT || 4)

let active = 0
const stats = { requests: 0, rejected: 0, retried: 0, maxActive: 0 }

const MODELS = {
  object: 'list',
  data: [
    { id: 'big-pickle', object: 'model', owned_by: 'our-free-model', context_window: 262144, x_ofm_efforts: ['light', 'balanced', 'deep'] },
    { id: 'deepseek-v4.1-flash-free', object: 'model', owned_by: 'our-free-model', context_window: 1048576, x_ofm_efforts: ['disabled', 'low', 'high', 'max'] },
    { id: 'jev-1.13-free', object: 'model', owned_by: 'our-free-model', context_window: 32768 },
  ],
}

function cors() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, x-api-key, x-goog-api-key, x-goog-api-client',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '600',
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { ...cors(), 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

const server = http.createServer((req, res) => {
  stats.requests++
  const url = req.url || '/'
  const bare = url.split('?')[0]

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...cors(), 'content-length': '0' })
    return res.end()
  }

  const presented = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
  if (presented !== LAN_KEY) {
    stats.rejected++
    return json(res, 401, { error: { type: 'unauthorized', message: 'bad lan key' } })
  }

  if (bare === '/v1/models') return json(res, 200, MODELS)

  if (bare === '/stats') return json(res, 200, stats)

  if (bare === '/v1/chat/completions') {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body = {}
      try { body = JSON.parse(raw) } catch {}
      if (body.model === 'jev-1.13-free') {
        return json(res, 400, {
          error: { message: 'Model does not support this protocol.', type: 'invalid_request_error', code: 'CLIENT_ERROR', param: null },
        })
      }
      if (body.stream) {
        res.writeHead(200, { ...cors(), 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
        res.write('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n')
        res.write('data: {"choices":[{"index":0,"delta":{"reasoning":"thinking"},"finish_reason":null}]}\n\n')
        res.write('data: {"choices":[{"index":0,"delta":{"content":"pong"},"finish_reason":null}]}\n\n')
        res.write('data: {"choices":[],"usage":{"prompt_tokens":3981,"completion_tokens":3,"total_tokens":3984}}\n\n')
        res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n')
        return res.end('data: [DONE]\n\n')
      }
      json(res, 200, {
        id: 'chatcmpl-mock', object: 'chat.completion', created: 1795417036,
        model: body.model || 'unknown',
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3981, completion_tokens: 3, total_tokens: 3984 },
      })
    })
    return
  }

  json(res, 404, { error: { type: 'not_found', message: bare } })
})

// Saturation: the fifth concurrent request is refused the way the real relay
// refuses, so the gateway's retry path is actually exercised.
server.on('request', () => {})
const originalEmit = server.emit.bind(server)
server.emit = (event, ...args) => {
  if (event === 'request') {
    const [req, res] = args
    if (req.method !== 'OPTIONS' && !String(req.url).includes('/stats')) {
      if (active >= MAX_CONCURRENT) {
        stats.rejected++
        const body = JSON.stringify({ error: { message: 'upstream saturated', type: 'overloaded' } })
        res.writeHead(502, { ...cors(), 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
        res.end(body)
        return true
      }
      active++
      stats.maxActive = Math.max(stats.maxActive, active)
      res.on('close', () => { active-- })
    }
  }
  return originalEmit(event, ...args)
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] 127.0.0.1:${PORT} lan key ${LAN_KEY} max ${MAX_CONCURRENT} concurrent`)
})
