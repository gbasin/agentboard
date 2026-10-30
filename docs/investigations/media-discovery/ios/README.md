# Native iOS Safari validation — 2026-10-26

Accepted run: **1 XCTest passed**, 57.5 seconds, on a dedicated iPhone 17 Pro simulator running iOS 26.4 on M5P. No simulator ran locally. Candidate SHA-256 is recorded in `candidate-sha256.txt`.

The browser used `http://100.82.11.20:59813`, a private synthetic fixture proxy over Tailscale HTTP. This exercises the insecure-origin clipboard fallback, unlike localhost HTTP. The fixture used the compiled candidate, private database, private tmux socket, one valid PNG and 120 external links. No production data or port 4040 was used.

| Check | Result |
| --- | --- |
| Panel closed | No new item-page request |
| Open Media | One stream request, 893 response bytes; valid image visible |
| Select Links | One stream request, 21,819 response bytes; newest link first |
| Copy | Visible checkmark and accessible “Link copied”; no keyboard opened |
| Clipboard | Native Safari Paste into a separate textarea exactly matched all 3,360 characters of the external URL |
| Background | Home for 10 seconds; no additional item request |
| Resume | Waited 8 seconds; Links panel and copy button remained available; no additional item request |
| Terminal | After collapse, native keyboard sent `IOS_DISCOVERY_FINAL_OK` exactly once; independently captured in `pane.txt` |

Evidence: `native.log`, `http.jsonl`, six PNG screenshots, and `ResumeUITests.swift`. The harness queries native accessibility elements, uses native touch/keyboard/Paste, and checks HTTP counts through a transparent proxy. Copy validation does not navigate to the external URL.

## Earlier harness attempts

Preserved in the raw result archive, not counted as passing runs:

- The first immediate accessibility tap left the pill collapsed and issued no item request. A two-second stabilization and center-coordinate native tap opened it. This does not establish a product-side cause for the first missed tap.
- The initial Media selector assumed a button accessibility role. Safari exposes pressed tab controls differently. The accepted harness selects their accessible label across element roles.
- The original 1-pixel PNG had an invalid IDAT CRC. The thumbnail endpoint correctly returned 422. Replacing synthetic fixture bytes with `TINY_PNG` from the E2E helper produced HTTP 200 and the visible thumbnail shown here.
- Safari hides its address field while the keyboard is open. The harness now taps native Done before navigating to the paste check.
- A default Xcode DerivedData run executed an older harness despite the new source. The accepted run uses an isolated DerivedData directory.

## Limits

This validates native Safari and insecure HTTP clipboard behavior in a simulator. It does not validate physical cellular service, an installed Home Screen app, long suspension, memory-pressure tab eviction, or the production tmux workload. This small fixture was already indexed before opening Media; indexing-in-progress and larger pagination scenarios are covered separately by automated browser/backend tests. No production source was changed for this validation.

Dedicated server, both proxies, SSH tunnel, private tmux sessions, and the M5P simulator were stopped after validation. Raw xcresults are archived outside Git at `/tmp/agentboard-media-discovery-native-41507-results.tar.gz`.
