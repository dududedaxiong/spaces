#!/usr/bin/env sh
set -eu

APP_PORT="${APP_PORT:-4173}"
PUBLIC_PORT="${PORT:-7860}"
export APP_ORIGIN="${APP_ORIGIN:-http://127.0.0.1:${APP_PORT}}"
export REMOTE_FOLDER="${REMOTE_FOLDER:-huggingface:notes}"

APP_PID=""
PROXY_PID=""

log() {
  printf '%s\n' "$*"
}

setup_rclone_config() {
  if [ -n "${RCLONE_CONF:-}" ] || [ -n "${RCLONE_CONFIG_BASE64:-}" ] || [ -n "${RCLONE_CONFIG_CONTENT:-}" ]; then
    mkdir -p /root/.config/rclone
    umask 077
    export RCLONE_CONFIG="${RCLONE_CONFIG:-/root/.config/rclone/rclone.conf}"

    if [ -n "${RCLONE_CONF:-}" ]; then
      printf '%s' "$RCLONE_CONF" > "$RCLONE_CONFIG"
      log "rclone config loaded from RCLONE_CONF."
    elif [ -n "${RCLONE_CONFIG_BASE64:-}" ]; then
      printf '%s' "$RCLONE_CONFIG_BASE64" | base64 -d > "$RCLONE_CONFIG"
      log "rclone config loaded from RCLONE_CONFIG_BASE64."
    else
      printf '%s' "$RCLONE_CONFIG_CONTENT" > "$RCLONE_CONFIG"
      log "rclone config loaded from RCLONE_CONFIG_CONTENT."
    fi

    chmod 600 "$RCLONE_CONFIG"
    return
  fi

  log "No rclone config file secret found; using rclone environment remote config if provided."
}

shutdown() {
  log "Shutting down, running final backup..."
  node scripts/backup-sqlite.mjs --backup >/tmp/final-backup.log 2>&1 || log "Final backup failed."
  if [ -n "$PROXY_PID" ]; then kill "$PROXY_PID" 2>/dev/null || true; fi
  if [ -n "$APP_PID" ]; then kill "$APP_PID" 2>/dev/null || true; fi
  wait 2>/dev/null || true
}

trap shutdown INT TERM

mkdir -p data
setup_rclone_config

log "Restoring database from ${REMOTE_FOLDER}/notes.db if it exists..."
node scripts/backup-sqlite.mjs --restore || log "Restore skipped or failed; continuing with local initialization."

log "Starting app on ${APP_ORIGIN}..."
PORT="$APP_PORT" node server.mjs &
APP_PID="$!"

log "Starting backup proxy on port ${PUBLIC_PORT}..."
PORT="$PUBLIC_PORT" node scripts/backup-proxy.mjs &
PROXY_PID="$!"

wait "$PROXY_PID"
