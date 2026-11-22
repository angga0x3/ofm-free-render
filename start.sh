#!/usr/bin/env bash
# Render start script for Our Free Model standalone.
#
# Why this shape: the standalone service binds 127.0.0.1 only — management and
# inference are loopback by design, and a non-loopback bind is rejected. Render
# routes to $PORT on 0.0.0.0. Two hops solve that:
#
#   Render :$PORT → health-shim (public, answers /health) → relay 0.0.0.0:$RELAY_PORT
#                 → service 127.0.0.1:$INTERNAL_PORT
#
# The relay is the service's own LAN mode, so the admin surface stays loopback
# while inference is reachable. The shim exists because the relay answers 401 to
# Render's unauthenticated health probe.
set -euo pipefail

PORT="${PORT:-10000}"
DATA_DIR="${OFM_HOME:-/data/ofm}"
INTERNAL_PORT="${OFM_INTERNAL_PORT:-18900}"
RELAY_PORT="${OFM_RELAY_PORT:-18901}"

mkdir -p "$DATA_DIR"

# Persisted settings make --lan sticky, but a fresh disk starts without them.
node - "$DATA_DIR" "$RELAY_PORT" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [dataDir, relayPort] = process.argv.slice(2)
const file = path.join(dataDir, 'settings.json')
let settings = {}
try { settings = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
settings.standaloneLanEnabled = true
settings.standaloneLanPort = Number(relayPort)
fs.mkdirSync(dataDir, { recursive: true })
fs.writeFileSync(file, JSON.stringify(settings, null, 2), { mode: 0o600 })
console.log(`[start] relay 0.0.0.0:${relayPort} · shim 0.0.0.0:${process.env.PORT} · data ${dataDir}`)
NODE

# A container killed mid-flight leaves the lock behind.
rm -f "$DATA_DIR/service.lock"

node health-shim.mjs &
SHIM=$!
trap 'kill $SHIM 2>/dev/null || true' EXIT

exec node packages/standalone/cli.mjs \
  --port "$INTERNAL_PORT" \
  --data-dir "$DATA_DIR" \
  --lan \
  --lan-port "$RELAY_PORT"
