# Internal TestFlight

Use the personal Apple developer team for Agentboard. Keep the bundle identifier
`dev.agentboard.ios-spike` so a TestFlight install can replace the development app.

## Automated releases

The iOS app has its own release-please package. Conventional commits that change
`ios/` update an iOS release PR. Merge that PR to bump `ios/version.txt`,
`MARKETING_VERSION`, and the iOS changelog. The resulting `ios-vX.Y.Z` tag starts
**Publish TestFlight**. Server/npm releases keep their existing `vX.Y.Z` tags.

The workflow archives the tagged source, signs it, uploads an internal-only
build, waits for Apple processing, and confirms assignment to **Personal**.
A successful upload alone does not count as a successful publishing run.

For a build between releases:

1. Open **Actions → Publish TestFlight → Run workflow** on `master`.
2. Select a commit already on `master`, or an `ios-vX.Y.Z` tag.
3. Leave **publish** off to validate a signed export without uploading.
4. Enable **publish** to distribute the build to internal testers.
5. Check the run summary for processing and group-assignment confirmation.
6. Install the update through TestFlight.
7. Verify connection, terminal input, attachments, and reconnection on the phone.

Each workflow run uses build number `1000 + run number`, followed by the run
attempt (for example, `1001.1`). The marketing version comes from
`ios/version.txt`. Start a new run if a newer build has already been uploaded;
rerunning an older workflow can produce a lower build number. Do not rename the
workflow or reset its numbering without updating this allocation scheme.

Publishing is serialized. GitHub retains one running and one pending run per
concurrency group; a newer pending run can replace an older pending run. Check
that the intended release completed, and dispatch it again if necessary.

If Apple processing times out, inspect App Store Connect before uploading again.
The existing upload may finish later. Build logs, exported IPAs, and debug symbols
remain available as workflow artifacts for seven days. The workflow does not
replace the native test suite or the physical-device acceptance checks in
[RELEASE-VALIDATION.md](RELEASE-VALIDATION.md).

### Credentials and renewal

The `ios-testflight` GitHub environment permits only `master` and `ios-v*` tags.
The workflow also requires the selected source to be an ancestor of `master`.
PR workflows do not receive publishing credentials.

Environment secrets:

- `ASC_PRIVATE_KEY`: App Store Connect App Manager API key.
- `IOS_SIGNING_P12_BASE64`: Base64-encoded Apple Distribution certificate and key.
- `IOS_SIGNING_P12_PASSWORD`: Password for the P12 file.
- `IOS_PROFILE_BASE64`: Base64-encoded App Store provisioning profile.

Environment variables: `ASC_KEY_ID`, `ASC_ISSUER_ID`, `IOS_TEAM_ID`,
`IOS_APP_ID`, and `IOS_BETA_GROUP_ID`.

The dedicated **Agentboard GitHub TestFlight** certificate/profile expire on
**November 9, 2027**. Replace the P12, password, and profile secrets before then.
Run a signed-export validation after renewal. Rotate the API key separately if
revoked or compromised. Keep the business Apple account unchanged.

Signing uses a temporary keychain. Cleanup removes the imported credentials and
profile and restores the previous keychain search list. Private keys and
passwords must never be committed or uploaded as workflow artifacts.

## Manual recovery archive

1. Sign into Xcode with the Apple Account that owns the team.
2. Run `bash ios/scripts/prepare.sh` from the repository root.
3. Run `bash ios/scripts/archive-testflight.sh TEAM_ID BUILD_NUMBER`.
4. Use a new positive build number for each upload.
5. Open `ios/.build-testflight/BUILD_NUMBER/Agentboard.xcarchive` in Xcode.

Run the archive command in a logged-in desktop Terminal when signing needs a
Keychain prompt. SSH sessions may report “User interaction is not allowed.”
Enter passwords in the macOS prompt. Do not put passwords in scripts or logs.

The archive uses Release configuration. Debug injection is disabled. Version
metadata comes from `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in the
project settings. The script overrides the build number for the archive.

## Distribute internally

1. Create or select the Agentboard app record in App Store Connect.
2. Select the personal team and the existing bundle identifier.
3. Choose **Distribute App → TestFlight Internal Only** in Xcode Organizer.
4. Resolve validation errors before uploading.
5. Wait for Apple to process the build.
6. Add the build to an internal tester group for the account owner.
7. Install the build through TestFlight on the iPhone.
8. Verify the server address, session list, terminal input, and reconnection.

An uploaded archive is not proof that a build is available to testers. Confirm
processing and group assignment in App Store Connect. Internal distribution does
not publish the app on the App Store. Hosted Simulator failures remain separate
release-readiness work; this pipeline does not waive them.

## App icon

`AgentboardSpike/Assets.xcassets/AppIcon.appiconset/AppIcon.png` is a 1024-pixel
render of the existing `public/favicon.svg`, flattened over its teal background
to remove transparency. The asset catalog supplies the iOS app icon.

Do not commit archives, provisioning profiles, certificates, or private keys.

## Setup checkpoint — 2026-11-09

- Release archive `0.1.0 (2)` built on m5p-2 with Xcode 27.2.
- Archive location: `/Users/gary/Code/agentboard-testflight/ios/.build-testflight/2/Agentboard.xcarchive`.
- Strict code-signature verification passed. The archive contains the app icon
  and the expected version and build number.
- App Store Connect record: **Agentboard: AI Terminal**. The plain name was
  unavailable. The home-screen name remains Agentboard.
- The personal team's explicit bundle registration is confirmed. The app uses
  English (U.S.) and SKU `agentboard-ios`.
- Internal-only upload of build 2 succeeded on 2026-11-09. Apple processing
  completed. Encryption information was saved for the system-only networking
  implementation. The build is ready to test.
- Internal group **Personal** has automatic distribution enabled, build 2
  assigned, and the account owner as its only tester. App Store Connect confirms
  **Invited** for the personal account. The user confirmed installation and a
  successful connection in the app on 2026-11-09. Broader physical-device
  acceptance remains open.
- Computer use recovered after restarting the Codex session.
- Lint, typechecking, and all pre-commit checks passed for `47cb217` with
  `LOG_LEVEL` removed from the command environment. Earlier attempts encountered
  an inherited logger setting and a transient wall-clock timing failure.

## Release metadata follow-up — 2026-11-09

The project now sets `ITSAppUsesNonExemptEncryption=false`, matching the system-only networking answer used for build 2. The app uses URLSession/WebKit networking and does not bundle a separate encryption implementation. Reassess the declaration if that changes. [Apple documents this property and the operating-system networking exemption](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations).

Build 4 (`0.1.0`) is signed, strictly verified, uploaded and processed. App Store Connect confirmed **Testing** and assignment to the **Personal** internal group on November 9. Xcode Organizer's TestFlight Internal Only flow succeeded after desktop access was restored; the earlier CLI account-access rejection did not block this GUI upload. The tester record still showed build 2 installed at verification time. Build 3 was not uploaded.

The harness logos merged in #558 are newer than build 4 and require the next TestFlight upload. Current validation limits are in [RELEASE-VALIDATION.md](RELEASE-VALIDATION.md).
