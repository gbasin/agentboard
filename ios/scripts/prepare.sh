#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p ios/AgentboardSpike/Web/vendor
cp node_modules/@xterm/xterm/lib/xterm.js ios/AgentboardSpike/Web/vendor/
cp node_modules/@xterm/xterm/css/xterm.css ios/AgentboardSpike/Web/vendor/
cp node_modules/@xterm/addon-fit/lib/addon-fit.js ios/AgentboardSpike/Web/vendor/
cp node_modules/@xterm/xterm/LICENSE ios/AgentboardSpike/Web/vendor/xterm-LICENSE
cp node_modules/@xterm/addon-fit/LICENSE ios/AgentboardSpike/Web/vendor/addon-fit-LICENSE
xcodegen generate --spec ios/project.yml
