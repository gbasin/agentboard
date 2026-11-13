#!/bin/bash
# Seed a real document in Files, independent of app installation/container changes.
set -euo pipefail
udid=${1:?Usage: seed-file.sh SIMULATOR_UDID SOURCE_FILE}
source_file=${2:?Usage: seed-file.sh SIMULATOR_UDID SOURCE_FILE}
groups=$(xcrun simctl get_app_container "$udid" com.apple.DocumentsApp groups)
storage=$(printf '%s\n' "$groups" | awk -F '\t' '$1 == "group.com.apple.FileProvider.LocalStorage" { print $2 }')
if [ -z "$storage" ] || [ ! -d "$storage" ]; then
  echo "Files local storage is unavailable for Simulator $udid" >&2
  exit 1
fi
mkdir -p "$storage/File Provider Storage"
cp "$source_file" "$storage/File Provider Storage/parity-upload.txt"
