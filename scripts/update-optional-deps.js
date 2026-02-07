#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];

if (!version) {
  console.error("Usage: node update-optional-deps.js <version>");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

pkg.optionalDependencies = {
  "@gbasin/agentboard-darwin-arm64": version,
  "@gbasin/agentboard-darwin-x64": version,
  "@gbasin/agentboard-linux-x64": version,
  "@gbasin/agentboard-linux-arm64": version,
};

writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");

console.log(`Updated optionalDependencies to version ${version}`);
