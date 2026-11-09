# External acceptance follow-up

These checks use m5p's iPhone 17 Pro Simulator, iOS 26.4, and the private parity backend. They do not certify physical-device behavior.

## Real Codex image editor

The native system clipboard control imported a generated PNG. Attachment review uploaded and inserted it into a disposable Codex CLI 0.145.0 session. The real editor displayed `[Image #1]`. No prompt was submitted and no inference was requested. This verifies editor attachment acceptance, not a model's interpretation of the image or other agent editors.

Result: `/tmp/ab-ci-external-dark.xcresult`, `ExternalAcceptanceUITests/testImageAcceptedByRealCodexEditor`, passed in 17.399 seconds. The same bundle contains an earlier failed document-navigation test, so the bundle is not a full pass.

## PDF saved through Files

The native PDF preview opened the iOS share sheet. “Save to Files” saved the document into the Agentboard directory under On My iPhone. A separate filesystem check confirmed the saved bytes match `nativePDFFixture()`:

- Filename: `Document.pdf`
- Size: 666 bytes
- SHA-256: `32dcc215497c29463ff7670ea425ad2c39758cb385059f4024764ffed1cb1f98`
- Header: `%PDF-1.4`

Result: `/tmp/ab-share-slow-light-3.xcresult`, `ExternalAcceptanceUITests/testDocumentShareToFiles`, passed in 28.021 seconds. Other share destinations, iCloud, and physical-device sharing remain unverified.

## Hosted failures and corrections

Hosted run `42507761352` passed all 72 native unit/integration tests, 32/34 light UI tests and 24/26 dark UI tests. Its failures were traced to test interactions:

- Search contained `anative-live-one` after XCTest's Command-A sequence. Tests now use native Clear text.
- Files was still loading after five seconds, or reopened directly in the app folder. Tests now wait for the picker and inspect its current location.
- The Photos first-use notice arrived after the test checked for it. Tests now wait for the notice or photo grid.
- A local dark correction run exposed XCTest's menu auto-scroll losing a Button/PopUpButton target. The helper now taps the verified visible center.

Light search/file/photo correction tests passed together. Dark file and photo tests passed across correction runs. A new hosted run checks their combined result; targeted passes do not turn the earlier failed bundles green.

## Repeat the optional checks

Start the isolated backend and normal fixtures from `ios/README.md`. Keep `NATIVE_PARITY_SHELL_RESUME=1`. Run `bun ios/scripts/slow-media-fixture.ts` from the checkout on the Simulator host before selecting the slow-discovery test. It creates one private history record and serves a loopback-only control on port 4194. A test-triggered POST appends 500,000 unique references (about 120 MB); restart this fixture before each run.

The image-editor test requires a disposable session named `native-image-acceptance` running Codex in `/tmp/ab-ios-parity/image-acceptance`. Open the empty editor first, dismiss its update/trust prompts, and do not submit a prompt. The test only imports an image and checks the editor's attachment marker.

Set `TEST_RUNNER_AGENTBOARD_EXTERNAL_ACCEPTANCE=1` on `xcodebuild test`, then select an individual `AgentboardSpikeUITests/ExternalAcceptanceUITests` test. Use the same Simulator destination and project as the standard native suite. These checks are opt-in and are not silently counted as part of hosted CI.

## Real large-transcript discovery

The private fixture appended 500,000 distinct links to its initial reference: 500,001 items and 119,778,020 source bytes. The original native client stopped at a finite stream boundary; a pre-fix run remained pending at 447,574 indexed items. Source comparison confirmed that the PWA automatically renews up to three times. Native now follows that bounded policy, retains visible rows, resumes after background cancellation and rejects stale-generation callbacks.

- `/tmp/ab-discovery-renewal-light.xcresult`: 75 native tests and both optional light workflows passed. This was before the final lagging-catalog regression test.
- `/tmp/ab-discovery-renewal-dark-final.xcresult`: all 76 native tests passed; two new optional UI tests failed on navigation assumptions. This is a failed UI bundle.
- `/tmp/ab-discovery-dark-actions.xcresult`: both final dark/maximum-text workflows passed together: PDF sharing (38.361 seconds) and real discovery/background recovery/count/paging (87.621 seconds).

The optional test corrections scroll history above the search bar, use the system share sheet's View More action at maximum text size, wait for the initial media request before opening its page menu, and compare the count independently of numeric grouping. Earlier diagnostic runs also used the wrong ActivityIndicator selector and attempted to reuse an already-generated fixture; those failures are not counted as passes. No app typography or navigation layout was changed for these corrections.
