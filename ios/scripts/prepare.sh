#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p ios/AgentboardSpike/Web/vendor
cp node_modules/@xterm/xterm/lib/xterm.js ios/AgentboardSpike/Web/vendor/
cp node_modules/@xterm/xterm/css/xterm.css ios/AgentboardSpike/Web/vendor/
cp node_modules/@xterm/addon-fit/lib/addon-fit.js ios/AgentboardSpike/Web/vendor/
cp node_modules/@xterm/xterm/LICENSE ios/AgentboardSpike/Web/vendor/xterm-LICENSE
cp node_modules/@xterm/addon-fit/LICENSE ios/AgentboardSpike/Web/vendor/addon-fit-LICENSE
bun build ios/scripts/native-transcript.ts --target browser --format iife --outfile ios/AgentboardSpike/Web/vendor/native-transcript.js
cp node_modules/@xterm/addon-webgl/lib/addon-webgl.js ios/AgentboardSpike/Web/vendor/
cp node_modules/@xterm/addon-webgl/LICENSE ios/AgentboardSpike/Web/vendor/addon-webgl-LICENSE
xcodegen generate --spec ios/project.yml
