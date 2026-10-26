// Reject incomplete optional-dependency resolution before publishing a lockfile.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export function verifyPlatformLock(version, pkg, lockText) {
  if (!version) throw new Error("A release version is required");
  const parsed = ts.parseConfigFileTextToJson("bun.lock", lockText);
  if (parsed.error) throw new Error("Cannot parse bun.lock");
  for (const platform of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]) {
    const name = `@gbasin/agentboard-${platform}`;
    if (pkg.optionalDependencies?.[name] !== version ||
        parsed.config?.workspaces?.[""]?.optionalDependencies?.[name] !== version ||
        parsed.config?.packages?.[name]?.[0] !== `${name}@${version}`) {
      throw new Error(`Missing or mismatched platform dependency: ${name}@${version}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyPlatformLock(process.argv[2], JSON.parse(readFileSync("package.json", "utf8")),
    readFileSync("bun.lock", "utf8"));
  console.log("All four platform dependencies are locked at the release version");
}
