import { expect, test } from "bun:test";
import { verifyPlatformLock } from "./verify-platform-lock.js";

function fixture() {
  const optionalDependencies = Object.fromEntries(
    ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]
      .map((platform) => [`@gbasin/agentboard-${platform}`, "0.37.0"]),
  );
  return {
    pkg: { optionalDependencies },
    lock: {
      workspaces: { "": { optionalDependencies: { ...optionalDependencies } } },
      packages: Object.fromEntries(Object.keys(optionalDependencies).map((name) => [name, [`${name}@0.37.0`]])),
    },
  };
}

test("accepts a complete JSONC lockfile", () => {
  const { pkg, lock } = fixture();
  expect(() => verifyPlatformLock("0.37.0", pkg, JSON.stringify(lock).replace(/}$/, ",}"))).not.toThrow();
});

test("rejects an omitted optional package even when workspace metadata is current", () => {
  const { pkg, lock } = fixture();
  delete lock.packages["@gbasin/agentboard-darwin-arm64"];
  expect(() => verifyPlatformLock("0.37.0", pkg, JSON.stringify(lock))).toThrow("darwin-arm64");
});

test("rejects stale resolved versions and workspace versions", () => {
  const { pkg, lock } = fixture();
  lock.packages["@gbasin/agentboard-linux-x64"] = ["@gbasin/agentboard-linux-x64@0.36.3"];
  expect(() => verifyPlatformLock("0.37.0", pkg, JSON.stringify(lock))).toThrow("linux-x64");
  const fresh = fixture();
  fresh.lock.workspaces[""].optionalDependencies["@gbasin/agentboard-darwin-x64"] = "0.36.3";
  expect(() => verifyPlatformLock("0.37.0", fresh.pkg, JSON.stringify(fresh.lock))).toThrow("darwin-x64");
});

test("rejects invalid JSONC", () => {
  expect(() => verifyPlatformLock("0.37.0", {}, "{broken")).toThrow("Cannot parse");
});
