# Internal TestFlight

Use the personal Apple developer team for Agentboard. Keep the bundle identifier
`dev.agentboard.ios-spike` so a TestFlight install can replace the development app.

## Create an archive

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
- Internal-only upload stopped because the App Store Connect app record did not
  exist. No build has been uploaded or assigned to testers.
- The personal team's explicit bundle registration was submitted in Safari.
  Verify its completion, then create the Agentboard app record using that ID,
  English (U.S.), and SKU `agentboard-ios`.
- Computer use lost its native pipe during registration. The service was
  running, but subsequent `sky.list_apps()` probes reported startup failure.
  Restart or resume the full Codex session before continuing desktop work.
- Lint and typechecking passed. The initial repository test run hit the logger
  default-level assertion with inherited `LOG_LEVEL=debug`; its isolated rerun
  passed with that variable removed. A full rerun with the variable removed
  passed 2,115 tests and failed one wall-clock assertion in `syncIoTiming` (a
  nominal 60 ms operation took 131 ms). This is not a green full-suite result.
  The timing test file then passed all 14 tests in isolation.
