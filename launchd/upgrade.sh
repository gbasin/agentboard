#!/bin/bash
# Upgrade an installed release; package resolution happens only here.
set -euo pipefail
exec node "$(dirname "$0")/release.mjs" upgrade "$@"
