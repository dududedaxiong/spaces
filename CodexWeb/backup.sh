#!/usr/bin/env sh
set -eu

REMOTE_FOLDER="${REMOTE_FOLDER:-huggingface:/codex-web}"
PM2_APP_NAME="${PM2_APP_NAME:-codex-web-api}"
BACKUP_JOB_NAME="${BACKUP_JOB_NAME:-codex-web-backup}"

command -v pm2 >/dev/null 2>&1 || {
  echo "pm2 is required" >&2
  exit 1
}

# Remove the previous one-shot backup task if it already exists.
pm2 delete "$BACKUP_JOB_NAME" >/dev/null 2>&1 || true

echo "start backup job: $BACKUP_JOB_NAME"
echo "target remote: $REMOTE_FOLDER"
echo "app to stop during backup: $PM2_APP_NAME"

REMOTE_FOLDER="$REMOTE_FOLDER" PM2_APP_NAME="$PM2_APP_NAME" \
  pm2 start /bin/sh --name "$BACKUP_JOB_NAME" --no-autorestart --time -- /app/sync.sh backup

echo "backup job started. view logs with: pm2 logs $BACKUP_JOB_NAME --lines 100"
