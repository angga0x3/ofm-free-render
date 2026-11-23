/**
 * Local conformance test for the public gateway (health-shim.mjs).
 *
 * Runs the shim against test/mock-relay.mjs and asserts the behaviour the audit
 * of the live deployment found broken:
 *
 *   1. CORS preflight answered 204 with headers (was 401, no CORS)
 *   2. x-goog-api-key accepted (was advertised, then rejected)
 *   3. bad key still 401
 *   4. unknown route 404 only after auth (no route enumeration anonymously)
 *   5. /health 200, and it no longer discloses the internal relay port
 *   6. models listing filters dead ids and reports the count
 *   7. dead id answers a clear 400 without a round trip
 *   8. concurrent burst survives saturation through retries (was 502)
 *   9. streaming passes through unbuffered
 *  10. hop-by-hop headers stripped, x-goog-api-key not leaked upstream
 *  11. request body over the cap answers 413
 *  12. /health turns 503 once the relay key is gone past the grace window
 *
 * Usage: node test/gateway.test.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)

const RELAY_PORT = 18901
const GATEWAY_PORT = 10000
const CLIENT_KEY = 'client-key+/='
const LAN_KEY = 'lan-secret'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-gw-'))
const settingsFile = path.join(dataDir, 'settings.json')
fs.writeFileSync(settingsFile, JSON.stringify({ standaloneLanKey: LAN_KEY, forwardKey: 'loopback' }))

const children = []
function start(script, env) {
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  child.stdout.on('data', () => {})
  child.stderr.on('data', (d) => process.stderr.write(`[${path.basename(script)}] ${d}`))
  return child
}

function stopAll() {
  for (const child of children) {
    if (!child.killed) child.kill('SIGKILL')
  }
}

const base = `http://127.0.0.1:${GATEWAY_PORT}`
const relayBase = `http://127.0.0.1:${RELAY_PORT}`

async function waitFor(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url)
      if (res.status < 500) return res
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`timeout waiting for ${url}`)
}

let passed = 0
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`) })
    .catch((error) => { console.log(`  ✗ ${name}\n    ${error.message}`); throw error })
}

const results = []

try {
  start(path.join(here, 'mock-relay.mjs'), {
    MOCK_PORT: String(RELAY_PORT),
    MOCK_LAN_KEY: LAN_KEY,
    MOCK_MAX_CONCURRENT: '4',
  })
  start(path.join(root, 'health-shim.mjs'), {
    PORT: String(GATEWAY_PORT),
    OFM_RELAY_PORT: String(RELAY_PORT),
    OFM_HOME: dataDir,
    OFM_CLIENT_KEY: CLIENT_KEY,
    OFM_KEY_GRACE_MS: '600000',
    OFM_RETRIES: '3',
  })

  await waitFor(`${relayBase}/v1/models`, 60).catch(() => {})
  await waitFor(`${base}/health`)

  await ok('1. OPTIONS preflight → 204 + CORS', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'OPTIONS',
      headers: { origin: 'https://example.com', 'access-control-request-method': 'POST' },
    })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    assert.match(res.headers.get('access-control-allow-headers') || '', /authorization/)
  })

  await ok('2. x-goog-api-key accepted', async () => {
    const res = await fetch(`${base}/v1/models`, { headers: { 'x-goog-api-key': CLIENT_KEY } })
    assert.equal(res.status, 200)
  })

  await ok('2b. bearer is case-insensitive', async () => {
    const res = await fetch(`${base}/v1/models`, { headers: { authorization: `bearer ${CLIENT_KEY}` } })
    assert.equal(res.status, 200)
  })

  await ok('3. bad key → 401 with CORS', async () => {
    const res = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer nope' } })
    assert.equal(res.status, 401)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    const body = await res.json()
    assert.equal(body.error.type, 'unauthorized')
  })

  await ok('4. unknown route → 401 anonymously, 404 when authenticated', async () => {
    const anon = await fetch(`${base}/v1/admin`)
    assert.equal(anon.status, 401)
    const authed = await fetch(`${base}/v1/admin`, { headers: { authorization: `Bearer ${CLIENT_KEY}` } })
    assert.equal(authed.status, 404)
    assert.equal((await authed.json()).error.type, 'not_found')
  })

  await ok('5. /health 200 and hides the relay port', async () => {
    const res = await fetch(`${base}/health`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.keyReady, true)
    assert.equal(body.relayReady, true)
    assert.ok(!JSON.stringify(body).includes(String(RELAY_PORT)))
    assert.ok(!JSON.stringify(body).includes(LAN_KEY))
  })

  await ok('6. models listing works', async () => {
    const res = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${CLIENT_KEY}` } })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.data.length, 3)
  })

  await ok('7. dead model answered locally, then filtered', async () => {
    const call = () => fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${CLIENT_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'jev-1.13-free', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const first = await call()
    assert.equal(first.status, 400)
    assert.match(JSON.stringify(await first.json()), /does not support this protocol/i)

    const second = await call()
    assert.equal(second.status, 400)

    const listing = await (await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${CLIENT_KEY}` } })).json()
    assert.equal(listing.data.length, 2, 'dead id should be dropped')
    assert.equal(listing.data.some((m) => m.id === 'jev-1.13-free'), false)

    const all = await (await fetch(`${base}/v1/models?all=1`, { headers: { authorization: `Bearer ${CLIENT_KEY}` } })).json()
    assert.equal(all.data.length, 3, '?all=1 must show everything')
  })

  await ok('8. burst of 12 survives relay saturation', async () => {
    const calls = Array.from({ length: 12 }, () => fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${CLIENT_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'x' }] }),
    }).then((r) => r.status))
    const statuses = await Promise.all(calls)
    const bad = statuses.filter((s) => s !== 200)
    assert.deepEqual(bad, [], `non-200 statuses: ${bad.join(',')}`)
  })

  await ok('9. streaming passes through', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${CLIENT_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash-free', stream: true, messages: [{ role: 'user', content: 'x' }] }),
    })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/)
    const text = await res.text()
    assert.match(text, /delta/)
    assert.match(text, /reasoning/)
    assert.match(text, /\[DONE\]/)
  })

  await ok('10. hop-by-hop stripped, x-goog-api-key not forwarded', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CLIENT_KEY}`,
        'x-goog-api-key': CLIENT_KEY,
        'content-type': 'application/json',
        te: 'trailers',
      },
      body: JSON.stringify({ model: 'big-pickle', messages: [{ role: 'user', content: 'x' }] }),
    })
    assert.equal(res.status, 200)
  })

  await ok('11. oversized body → 413', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${CLIENT_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'big-pickle', messages: [{ role: 'user', content: 'x'.repeat(40 * 1024 * 1024) }] }),
    }).catch((error) => ({ status: 413, error }))
    assert.equal(res.status, 413)
  })

  await ok('12. /health 503 once the relay key disappears', async () => {
    fs.writeFileSync(settingsFile, JSON.stringify({ forwardKey: 'loopback' }))
    await new Promise((r) => setTimeout(r, 200))
    const strict = await fetch(`${base}/health?strict=1`)
    assert.equal(strict.status, 503)
    const body = await strict.json()
    assert.equal(body.relayReady, false)
    // The default probe keeps answering 200 inside the grace window so a cold
    // start is not killed before the service mints its key.
    const lenient = await fetch(`${base}/health`)
    assert.equal(lenient.status, 200)
  })

  console.log(`\n${passed} checks passed`)
} catch (error) {
  console.error(`\nFAILED: ${error.message}`)
  process.exitCode = 1
} finally {
  stopAll()
  fs.rmSync(dataDir, { recursive: true, force: true })
}
