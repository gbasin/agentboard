#!/bin/bash
# Check the actual PDF written by the native Save to Files journey.
set -euo pipefail
udid=${1:?Usage: verify-file-export.sh SIMULATOR_UDID EXPECTED_PDF}
expected=${2:?Usage: verify-file-export.sh SIMULATOR_UDID EXPECTED_PDF}
groups=$(xcrun simctl get_app_container "$udid" com.apple.DocumentsApp groups)
storage=$(printf '%s\n' "$groups" | awk -F '\t' '$1 == "group.com.apple.FileProvider.LocalStorage" { print $2 }')
if [ -z "$storage" ] || [ ! -d "$storage" ]; then
  echo "Files local storage is unavailable for Simulator $udid" >&2
  exit 1
fi
cmp "$expected" "$storage/File Provider Storage/Agentboard E2E Exports/Document.pdf"
