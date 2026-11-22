#!/usr/bin/env bash
# Render start script for Our Free Model standalone.
#
# Why this shape: the standalone service binds 127.0.0.1 only — management and
# inference are loopback by design, and a non-loopback bind is rejected. Render
# routes to $PORT on 0.0.0.0. Two hops solve that:
#
#   Render :$PORT → gateway (public: /health + /v1/*, swaps the key)
#                 → relay 0.0.0.0:$RELAY_PORT → service 127.0.0.1:$INTERNAL_PORT
#
# The relay is the service's own LAN mode, so the admin surface stays loopback
# while inference is reachable. The gateway exists because the relay answers 401
# to Render's unauthenticated health probe.
#
# Key handling — one rule, learned by measurement: NEVER write OFM_CLIENT_KEY into
# `standaloneLanKey`. The service treats `lanKey === forwardKey` as "unset" and
# re-mints on every boot, which silently breaks a disk-backed setup. So this
# script seeds only `forwardKey` (the loopback API's own key) and lets the service
# mint and persist its LAN key. The gateway then reads that LAN key and swaps it
# for whatever the client presents.
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

node - "$DATA_DIR" "$RELAY_PORT" "$CLIENT_KEY" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [dataDir, relayPort, clientKey] = process.argv.slice(2)
const file = path.join(dataDir, 'settings.json')
let settings = {}
try { settings = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}

settings.standaloneLanEnabled = true
settings.standaloneLanPort = Number(relayPort)

// forwardKey belongs to the loopback API. Pin it once, never overwrite.
if (!settings.forwardKey && clientKey) settings.forwardKey = clientKey

// Drop a LAN key that equals forwardKey — the service would re-mint it anyway,
// and leaving it would misreport "persisted" in the log below.
if (settings.standaloneLanKey && settings.standaloneLanKey === settings.forwardKey) {
  delete settings.standaloneLanKey
}

fs.mkdirSync(dataDir, { recursive: true })
fs.writeFileSync(file, JSON.stringify(settings, null, 2), { mode: 0o600 })
console.log(`[start] relay 0.0.0.0:${relayPort} · gateway 0.0.0.0:${process.env.PORT} · data ${dataDir}`)
console.log(`[start] client key ${clientKey ? 'set' : 'MISSING'} · lan key ${settings.standaloneLanKey ? 'persisted' : 'will be minted'}`)
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
