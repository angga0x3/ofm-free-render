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
#
# Free tier has no persistent disk, so the data dir lives inside the checkout and
# is rebuilt on every boot. Both keys are therefore seeded from env, not minted:
# a minted key would change on each deploy and every client would break.
set -euo pipefail

PORT="${PORT:-10000}"
DATA_DIR="${OFM_HOME:-$PWD/ofm-data}"
INTERNAL_PORT="${OFM_INTERNAL_PORT:-18900}"
RELAY_PORT="${OFM_RELAY_PORT:-18901}"
CLIENT_KEY="${OFM_CLIENT_KEY:-}"

mkdir -p "$DATA_DIR"

if [ -z "$CLIENT_KEY" ]; then
  echo "[start] OFM_CLIENT_KEY is empty — clients will not be able to authenticate" >&2
fi

# Seed settings.json: LAN relay on, and both keys pinned to the env value so a
# reboot keeps the same credentials.
node - "$DATA_DIR" "$RELAY_PORT" "$CLIENT_KEY" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [dataDir, relayPort, clientKey] = process.argv.slice(2)
const file = path.join(dataDir, 'settings.json')
let settings = {}
try { settings = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
settings.standaloneLanEnabled = true
settings.standaloneLanPort = Number(relayPort)
if (clientKey) {
  // The relay checks the LAN key; the local API checks forwardKey. Point both at
  // the same env-provided value so one key works on either port.
  settings.standaloneLanKey = clientKey
  settings.forwardKey = clientKey
}
fs.mkdirSync(dataDir, { recursive: true })
fs.writeFileSync(file, JSON.stringify(settings, null, 2), { mode: 0o600 })
console.log(`[start] relay 0.0.0.0:${relayPort} · shim 0.0.0.0:${process.env.PORT} · data ${dataDir}`)
console.log(`[start] client key: ${clientKey ? 'pinned from env' : 'MISSING'}`)
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
