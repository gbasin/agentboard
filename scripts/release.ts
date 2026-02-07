#!/usr/bin/env bun

import { $ } from "bun";

// Types
interface Commit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
}

interface GroupedCommits {
  feat: Commit[];
  fix: Commit[];
  chore: Commit[];
  docs: Commit[];
  style: Commit[];
  refactor: Commit[];
  perf: Commit[];
  other: Commit[];
}

type VersionType = "patch" | "minor" | "major";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const blue = (s: string) => `\x1b[34m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const gray = (s: string) => `\x1b[90m${s}\x1b[0m`;

const versionType = process.argv[2] as VersionType;
const validVersionTypes: VersionType[] = ["patch", "minor", "major"];

if (!validVersionTypes.includes(versionType)) {
  console.error(red("Error: Invalid version type"));
  console.log(yellow("\nUsage: bun run release:[patch|minor|major]"));
  console.log(gray("  patch: 0.1.0 -> 0.1.1"));
  console.log(gray("  minor: 0.1.0 -> 0.2.0"));
  console.log(gray("  major: 0.1.0 -> 1.0.0"));
  process.exit(1);
}

function spinner(message: string) {
  process.stdout.write(`  ${message}`);
  return {
    succeed: (msg?: string) => {
      process.stdout.write(`\r  ${msg || message}\n`);
    },
    fail: (msg?: string) => {
      process.stdout.write(`\r  ${msg || message}\n`);
    },
    warn: (msg?: string) => {
      process.stdout.write(`\r  ${msg || message}\n`);
    },
  };
}

async function checkGitStatus(): Promise<boolean> {
  const spin = spinner("Checking git status...");

  try {
    await $`git rev-parse --git-dir`.quiet();
    const status = await $`git status --porcelain`.text();

    if (status.trim()) {
      const changedFiles = status.trim().split("\n");
      const onlyReleaseScript = changedFiles.every((line) => {
        const file = line.substring(3);
        return file === "scripts/release.ts" || file.endsWith("/release.ts");
      });

      if (onlyReleaseScript) {
        spin.warn(
          "Uncommitted changes to release script detected (allowed for testing)"
        );
        return true;
      }

      spin.fail("Working directory is not clean");
      console.log(red("\nYou have uncommitted changes:"));
      console.log(gray(status));
      console.log(
        yellow("\nTip: Commit or stash your changes before releasing")
      );
      return false;
    }

    spin.succeed("Git status is clean");
    return true;
  } catch (error) {
    spin.fail("Failed to check git status");
    console.error(red((error as Error).message));
    return false;
  }
}

function getNextVersion(currentVersion: string, type: VersionType): string {
  const parts = currentVersion.split(".").map(Number);

  switch (type) {
    case "major":
      return `${parts[0] + 1}.0.0`;
    case "minor":
      return `${parts[0]}.${parts[1] + 1}.0`;
    case "patch":
      return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  }
}

async function getLastTag(): Promise<string> {
  try {
    const tag = await $`git describe --tags --abbrev=0`.text();
    return tag.trim();
  } catch {
    const firstCommit = await $`git rev-list --max-parents=0 HEAD`.text();
    return firstCommit.trim().substring(0, 7);
  }
}

async function getCommitsSinceLastTag(): Promise<Commit[]> {
  const spin = spinner("Fetching commit history...");

  try {
    await $`git fetch --tags`.quiet();

    const lastTag = await getLastTag();
    const stdout =
      await $`git log ${lastTag}..origin/master --pretty=format:%H|%h|%s|%an --no-merges`.text();

    if (!stdout.trim()) {
      spin.succeed("No commits since last release");
      return [];
    }

    const commits = stdout
      .trim()
      .split("\n")
      .map((line) => {
        const [hash, shortHash, subject, author] = line.split("|");
        return { hash, shortHash, subject, author };
      });

    spin.succeed(`Found ${commits.length} commits since ${lastTag}`);
    return commits;
  } catch (error) {
    spin.warn("Could not fetch commit history");
    console.log(gray(`  Debug: ${(error as Error).message}`));
    return [];
  }
}

async function getRepoInfo(): Promise<string | null> {
  try {
    const stdout = await $`git remote get-url origin`.text();
    const match = stdout.match(/github\.com[:/](.+?)(?:\.git)?$/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function formatCommits(commits: Commit[], repoInfo: string | null): string {
  if (commits.length === 0) return "";

  const grouped: GroupedCommits = {
    feat: [],
    fix: [],
    chore: [],
    docs: [],
    style: [],
    refactor: [],
    perf: [],
    other: [],
  };

  for (const commit of commits) {
    const match = commit.subject.match(/^(\w+)(\(.+?\))?:/);
    const type = match ? match[1] : "other";
    const group = grouped[type as keyof GroupedCommits] || grouped.other;
    group.push(commit);
  }

  let changelog = "\n### Changes in this release\n\n";

  const typeLabels: Record<string, string> = {
    feat: "Features",
    fix: "Bug Fixes",
    chore: "Maintenance",
    docs: "Documentation",
    style: "Style",
    refactor: "Refactoring",
    perf: "Performance",
  };

  for (const [type, commits] of Object.entries(grouped)) {
    if (commits.length > 0 && type !== "other") {
      changelog += `#### ${typeLabels[type] || type}\n\n`;
      for (const commit of commits) {
        const commitLink = repoInfo
          ? `[${commit.shortHash}](https://github.com/${repoInfo}/commit/${commit.hash})`
          : commit.shortHash;
        changelog += `- ${commit.subject} (${commitLink}) by ${commit.author}\n`;
      }
      changelog += "\n";
    }
  }

  if (grouped.other.length > 0) {
    changelog += "#### Other Changes\n\n";
    for (const commit of grouped.other) {
      const commitLink = repoInfo
        ? `[${commit.shortHash}](https://github.com/${repoInfo}/commit/${commit.hash})`
        : commit.shortHash;
      changelog += `- ${commit.subject} (${commitLink}) by ${commit.author}\n`;
    }
    changelog += "\n";
  }

  return changelog;
}

async function checkGhCli(): Promise<boolean> {
  const spin = spinner("Checking GitHub CLI...");

  try {
    await $`gh --version`.quiet();
    await $`gh auth status`.quiet();
    spin.succeed("GitHub CLI is installed and authenticated");
    return true;
  } catch {
    spin.fail("GitHub CLI not found or not authenticated");
    console.log(yellow("\nTo install GitHub CLI:"));
    console.log(blue("   Visit: https://cli.github.com/"));
    console.log(gray("   Or run: brew install gh (macOS)"));
    console.log(gray("   Then: gh auth login"));
    return false;
  }
}

async function getMasterVersion(): Promise<string> {
  const spin = spinner("Getting version from master...");

  try {
    await $`git fetch origin master`.quiet();
    const stdout = await $`git show origin/master:package.json`.text();
    const packageJson = JSON.parse(stdout);

    spin.succeed(`Master branch version: ${packageJson.version}`);
    return packageJson.version;
  } catch (error) {
    spin.fail("Failed to get version from master");
    throw error;
  }
}

async function createReleaseBranch(version: string): Promise<string> {
  const spin = spinner("Creating release branch...");
  const branchName = `release/v${version}`;

  try {
    await $`git checkout -b ${branchName} origin/master`.quiet();
    spin.succeed(`Created branch: ${green(branchName)}`);
    return branchName;
  } catch (error) {
    spin.fail("Failed to create release branch");
    throw error;
  }
}

async function bumpVersion(expectedVersion: string): Promise<string> {
  const spin = spinner(`Bumping version to ${expectedVersion}...`);

  try {
    const packageJson = await Bun.file("package.json").json();
    packageJson.version = expectedVersion;
    if (packageJson.optionalDependencies) {
      for (const key of Object.keys(packageJson.optionalDependencies)) {
        if (key.startsWith("@gbasin/agentboard-")) {
          packageJson.optionalDependencies[key] = expectedVersion;
        }
      }
    }
    await Bun.write("package.json", JSON.stringify(packageJson, null, 2) + "\n");

    spin.succeed(`Version bumped to: ${green(`v${expectedVersion}`)}`);
    return expectedVersion;
  } catch (error) {
    spin.fail("Failed to bump version");
    throw error;
  }
}

async function commitChanges(version: string): Promise<void> {
  const spin = spinner("Committing changes...");

  try {
    await $`git add package.json`.quiet();
    await $`git commit -m ${"chore: bump version to v" + version}`.quiet();
    spin.succeed("Changes committed");
  } catch (error) {
    spin.fail("Failed to commit changes");
    throw error;
  }
}

async function pushBranch(branchName: string): Promise<void> {
  const spin = spinner("Pushing branch to GitHub...");

  try {
    await $`git push origin ${branchName}`.quiet();
    spin.succeed("Branch pushed to GitHub");
  } catch (error) {
    spin.fail("Failed to push branch");
    throw error;
  }
}

async function createPullRequest(
  branchName: string,
  version: string,
  type: VersionType
): Promise<void> {
  const spin = spinner("Creating pull request...");

  try {
    const commits = await getCommitsSinceLastTag();
    const repoInfo = await getRepoInfo();
    const commitHistory = formatCommits(commits, repoInfo);

    const title = `chore: release v${version}`;
    const body = `## Release v${version}

This PR bumps the version to **v${version}** (${type} release).
${commitHistory}
### What happens after merge:
1. Version tag will be created automatically
2. GitHub Actions will build binaries for all platforms
3. GitHub Release will be created with downloadable binaries
4. npm packages will be published to npm registry

---
*Created by the release script*`;

    const result =
      await $`gh pr create --title ${title} --body ${body} --base master --head ${branchName}`.text();

    spin.succeed("Pull request created");
    console.log(green("\nSuccess!"));
    console.log(blue(result.trim()));
  } catch (error) {
    spin.fail("Failed to create pull request");
    throw error;
  }
}

async function prompt(message: string): Promise<boolean> {
  process.stdout.write(`${message} (y/N) `);

  for await (const line of console) {
    const answer = line.trim().toLowerCase();
    return answer === "y" || answer === "yes";
  }
  return false;
}

async function main(): Promise<void> {
  console.log(bold(blue(`\nagentboard release - ${versionType} version\n`)));

  const isClean = await checkGitStatus();
  if (!isClean) process.exit(1);

  const hasGhCli = await checkGhCli();
  if (!hasGhCli) process.exit(1);

  const originalBranch = (await $`git branch --show-current`.text()).trim();
  console.log(gray(`Current branch: ${originalBranch}`));

  try {
    const masterVersion = await getMasterVersion();
    const nextVersion = getNextVersion(masterVersion, versionType);

    console.log(gray(`\nVersion in origin/master: ${masterVersion}`));
    console.log(green(`Next version will be:     ${nextVersion}`));

    const confirmed = await prompt(`\nCreate release for v${nextVersion}?`);
    if (!confirmed) {
      console.log(yellow("\nRelease cancelled"));
      process.exit(0);
    }

    console.log("");

    const branchName = await createReleaseBranch(nextVersion);
    const actualNewVersion = await bumpVersion(nextVersion);

    if (actualNewVersion !== nextVersion) {
      console.error(
        red(
          `Version mismatch! Expected ${nextVersion} but got ${actualNewVersion}`
        )
      );
      throw new Error("Version calculation mismatch");
    }

    await commitChanges(actualNewVersion);
    await pushBranch(branchName);
    await createPullRequest(branchName, actualNewVersion, versionType);

    console.log(green("\nRelease process completed!"));
    console.log(gray("\nNext steps:"));
    console.log(gray("1. Review and merge the PR"));
    console.log(gray("2. Tag will be created automatically on merge"));
    console.log(gray("3. GitHub Actions will build and release binaries"));

    if (originalBranch && originalBranch !== "master") {
      const returnToOriginal = await prompt(
        `\nReturn to branch '${originalBranch}'?`
      );
      if (returnToOriginal) {
        await $`git checkout ${originalBranch}`.quiet();
        console.log(green(`\nSwitched back to ${originalBranch}`));
      }
    }
  } catch (error) {
    console.error(red("\nRelease failed:"));
    console.error(red((error as Error).message));
    console.log(yellow("\nYou may need to:"));
    console.log(
      gray(
        `- Clean up the branch: git checkout ${originalBranch} && git branch -D release/...`
      )
    );
    console.log(gray("- Check your GitHub permissions"));

    try {
      await $`git checkout ${originalBranch}`.quiet();
      console.log(yellow(`\nReturned to ${originalBranch} after error`));
    } catch {}

    process.exit(1);
  }
}

main().catch(console.error);
