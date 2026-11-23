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
#
# Revision 2026-11-23 (audit of the live deployment):
#
# - `forwardKey` is now a local random secret instead of OFM_CLIENT_KEY. Render
#   `generateValue` produces base64 (`/`, `+`, `=`), which is harmless in an HTTP
#   header but is also handed to internal callers as a config value. The client
#   key stays an opaque string that only ever travels in a header.
# - Shutdown is bounded and group-wide. `exec` made the service PID 1, so no trap
#   ran and the relay port could stay bound across a fast redeploy; the next boot
#   then logged "LAN relay could not start (EADDRINUSE)" and served 502s.
# - The gateway is restarted in place if it dies, and its death no longer takes
#   the deployment down. If the service dies, the script exits so Render
#   restarts the instance.
set -euo pipefail

PORT="${PORT:-10000}"
DATA_DIR="${OFM_HOME:-$PWD/ofm-data}"
INTERNAL_PORT="${OFM_INTERNAL_PORT:-18900}"
RELAY_PORT="${OFM_RELAY_PORT:-18901}"
CLIENT_KEY="${OFM_CLIENT_KEY:-}"
NODE_BIN="${NODE_BIN:-node}"

mkdir -p "$DATA_DIR"

if [ -z "$CLIENT_KEY" ]; then
  echo "[start] OFM_CLIENT_KEY is empty — clients will not be able to authenticate" >&2
fi

"$NODE_BIN" - "$DATA_DIR" "$RELAY_PORT" "$CLIENT_KEY" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const [dataDir, relayPort, clientKey] = process.argv.slice(2)
const file = path.join(dataDir, 'settings.json')
let settings = {}
try { settings = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}

settings.standaloneLanEnabled = true
settings.standaloneLanPort = Number(relayPort)

// forwardKey belongs to the loopback API. Pin it once, never overwrite.
// Local random secret, not the client key: see the header comment.
if (!settings.forwardKey) settings.forwardKey = crypto.randomBytes(32).toString('base64')

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

SHIM_PID=""
SERVICE_PID=""
STOPPING=""

# setsid gives each child its own process group so cleanup can signal the whole
# tree. Falls back to a plain launch when setsid is unavailable.
launch() {
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" &
  else
    "$@" &
  fi
  echo $!
}

signal_group() {
  local sig="$1" pid="$2"
  [ -n "$pid" ] || return 0
  kill "-$sig" "-$pid" 2>/dev/null || kill "-$sig" "$pid" 2>/dev/null || true
}

cleanup() {
  STOPPING=1
  trap - EXIT INT TERM
  signal_group TERM "$SHIM_PID"
  signal_group TERM "$SERVICE_PID"
  # Bounded wait: a child that ignores TERM must not hold the port past Render's
  # own shutdown grace period.
  local waited=0
  while [ "$waited" -lt 40 ]; do
    if ! kill -0 "$SHIM_PID" 2>/dev/null && ! kill -0 "$SERVICE_PID" 2>/dev/null; then
      break
    fi
    sleep 0.25
    waited=$((waited + 1))
  done
  signal_group KILL "$SHIM_PID"
  signal_group KILL "$SERVICE_PID"
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

launch "$NODE_BIN" health-shim.mjs
SHIM_PID=$!

launch "$NODE_BIN" packages/standalone/cli.mjs \
  --port "$INTERNAL_PORT" \
  --data-dir "$DATA_DIR" \
  --lan \
  --lan-port "$RELAY_PORT"
SERVICE_PID=$!

while [ -z "$STOPPING" ]; do
  wait -n 2>/dev/null || true
  [ -n "$STOPPING" ] && break
  if ! kill -0 "$SERVICE_PID" 2>/dev/null; then
    echo "[start] service exited — shutting down so Render restarts the instance" >&2
    exit 1
  fi
  if ! kill -0 "$SHIM_PID" 2>/dev/null; then
    echo "[start] gateway exited — restarting it" >&2
    sleep 1
    launch "$NODE_BIN" health-shim.mjs
    SHIM_PID=$!
  fi
done
