#!/usr/bin/env sh
set -eu

# REMOTE_FOLDER example: remote:codex-web-backup
# The remote layout preserves local absolute paths under REMOTE_FOLDER:
#   /app/apps/api/data -> ${REMOTE_FOLDER}/app/apps/api/data
# BACKUP_PATHS entries ending in / are directories; other entries are files.
# Restore discovers top-level entries from REMOTE_FOLDER:
#   ${REMOTE_FOLDER}/data -> /data
#   ${REMOTE_FOLDER}/apps -> /apps
#   ${REMOTE_FOLDER}/app -> /app

BACKUP_PATHS="
/app/data/
/app/sync.sh
"

PM2_APP_NAME="${PM2_APP_NAME:-codex-web-api}"
PM2_STOPPED=0

start_pm2_app_if_stopped() {
  if [ "$PM2_STOPPED" = "1" ]; then
    echo "start pm2 app: $PM2_APP_NAME"
    pm2 start "$PM2_APP_NAME"
    PM2_STOPPED=0
  fi
}

stop_pm2_app_for_backup() {
  command -v pm2 >/dev/null 2>&1 || {
    echo "pm2 is required" >&2
    exit 1
  }

  trap 'start_pm2_app_if_stopped' EXIT INT TERM

  echo "stop pm2 app: $PM2_APP_NAME"
  pm2 stop "$PM2_APP_NAME"
  PM2_STOPPED=1
}

require_remote_folder() {
  if [ -z "${REMOTE_FOLDER:-}" ]; then
    echo "REMOTE_FOLDER is required, for example: REMOTE_FOLDER=remote:codex-web-backup" >&2
    exit 1
  fi
}

remote_path_for() {
  local_path="$1"
  printf "%s%s" "${REMOTE_FOLDER%/}" "$local_path"
}

backup() {
  require_remote_folder
  command -v rclone >/dev/null 2>&1 || {
    echo "rclone is required" >&2
    exit 1
  }

  stop_pm2_app_for_backup

  for backup_path in $BACKUP_PATHS; do
    case "$backup_path" in
      */)
        entry_type="dir"
        local_path="${backup_path%/}"
        ;;
      *)
        entry_type="file"
        local_path="$backup_path"
        ;;
    esac

    if [ ! -e "$local_path" ]; then
      echo "skip missing path: $backup_path"
      continue
    fi
    if [ "$entry_type" = "dir" ] && [ ! -d "$local_path" ]; then
      echo "skip non-directory path marked as directory: $backup_path" >&2
      continue
    fi
    if [ "$entry_type" = "file" ] && [ ! -f "$local_path" ]; then
      echo "skip non-file path marked as file: $backup_path" >&2
      continue
    fi

    remote_path="$(remote_path_for "$local_path")"
    echo "backup: $local_path -> $remote_path"
    if [ "$entry_type" = "dir" ]; then
      rclone copy "$local_path" "$remote_path" --create-empty-src-dirs
    else
      rclone copyto "$local_path" "$remote_path"
    fi
  done

  start_pm2_app_if_stopped
  trap - EXIT INT TERM
}

restore() {
  require_remote_folder
  command -v rclone >/dev/null 2>&1 || {
    echo "rclone is required" >&2
    exit 1
  }

  remote_root="${REMOTE_FOLDER%/}"
  entries="$(rclone lsf "$remote_root")"
  if [ -z "$entries" ]; then
    echo "remote folder is empty: $remote_root"
    return 0
  fi

  printf "%s\n" "$entries" | while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    clean_entry="${entry%/}"
    case "$clean_entry" in
      ""|.|..|/*|*"/../"*|../*|*".."/*)
        echo "skip unsafe remote entry: $entry" >&2
        continue
        ;;
    esac

    remote_path="$remote_root/$clean_entry"
    local_path="/$clean_entry"
    echo "restore: $remote_path -> $local_path"
    if [ "${entry%/}" != "$entry" ]; then
      mkdir -p "$local_path"
      rclone copy "$remote_path" "$local_path" --create-empty-src-dirs
    else
      mkdir -p "$(dirname "$local_path")"
      rclone copyto "$remote_path" "$local_path"
    fi
  done
}

case "${1:-}" in
  backup)
    backup
    ;;
  restore)
    restore
    ;;
  *)
    echo "Usage: REMOTE_FOLDER=remote:path $0 {backup|restore}" >&2
    exit 2
    ;;
esac
