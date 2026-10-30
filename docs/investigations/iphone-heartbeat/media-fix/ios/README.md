# Native iOS Safari media paging and background recovery

**Passed:** native XCTest on a dedicated iPhone 17 Pro simulator running iOS
26.4 on the remote M5P. The test used the compiled candidate, a real private
23-window/2,366-media fixture, and Safari through an SSH loopback forward.

| Native action | Cumulative descriptor-page HTTP requests |
| --- | ---: |
| Open terminal; Media closed | 0 |
| Tap Media | 1 |
| Swipe the media strip horizontally | 2 |
| Home/background for 10 seconds | 2 |
| Activate Safari; wait for terminal recovery | 2 |

The media panel remained open after returning. The native keyboard then sent
`IOS_MEDIA_NATIVE_OK`; independent capture of the private tmux pane contained
that marker exactly once. The accepted XCTest completed in 64.639 seconds with
zero failures. This is a functional check, not a latency benchmark.

Evidence: [request counts](request-counts.json), [HTTP trace](http.jsonl),
[accepted XCTest log](media-native2.log), [input evidence](terminal-input-evidence.txt),
and [candidate binary hash](candidate-sha256.txt).

Screenshots: [closed](media-closed.png), [first page](media-first-page.png),
[scrolled](media-scrolled.png), [resumed](media-resumed.png),
[native terminal input](media-terminal-input.png).

The first attempt failed before any media assertion: its session selector chose
a hidden duplicate sidebar row. The fixture already selected the intended
terminal, so the unnecessary selection step was removed. That failure remains
in [media-native.log](media-native.log); it is not a product regression or an
accepted run. The final [Swift harness](ResumeUITests.swift) uses native taps
and horizontal coordinate drags within the rendered strip. It does not execute
JavaScript scrolling or synthetic page lifecycle events.

## Reproduction

1. Build the candidate and start the isolated production-sized media fixture.
   The run used local port 55040 and private socket `/tmp/abcell-61139-pr/tmux-501/default`.
2. Adapt the destination port in [proxy.mjs](proxy.mjs), then start it from the
   worktree root with `.poc-stress-test/ios` present. It forwards HTTP/WebSocket
   bytes and logs HTTP request paths. Its `/__probe` endpoint serves only the
   native test's counters and stage markers.
3. Forward remote loopback port 5193 to local proxy port 55042:
   `ssh -N -R 5193:127.0.0.1:55042 garybasin@macbook-m5p`.
4. Copy `ResumeUITests.swift` and `ResumeUITests.xcodeproj` to a fresh remote
   temporary directory. Create a dedicated iPhone 17 Pro/iOS 26.4 simulator.
5. Run `xcodebuild test -project ResumeUITests.xcodeproj -scheme ResumeUITests
   -destination 'id=<dedicated-simulator-id>' -derivedDataPath build
   -resultBundlePath media-native.xcresult ONLY_ACTIVE_ARCH=YES` on M5P.
6. Independently capture the private fixture pane after the test and verify the
   marker occurs once. Export attachments with `xcrun xcresulttool export
   attachments --path media-native.xcresult --output-path attachments`.
7. Stop only the fixture, proxy, tunnel, and dedicated simulator created for
   this test. Do not touch production or another simulator.

## Scope

This tests native Safari taps, scrolling, a real Home/background transition,
resume, and native keyboard input. It does not test a physical cellular radio,
Tailscale path, OS memory eviction, long suspension, or an installed Home Screen
app. Those remain separate from the passing Simulator Safari result. The
candidate hash predates the final page-RPC queue bookkeeping hardening; the
media UI/protocol/index behavior exercised here is identified by the retained
binary hash. Later final-binary transport comparisons and source E2E tests
provide the corresponding final-build coverage.

Cleanup completed: the dedicated simulator was shut down and deleted; the
fixture server, private tmux sessions/socket alias, proxy, and SSH tunnel were
stopped. Ports 55040 and 55042 no longer had listeners. Remote temporary build
files were removed. Raw XCTest result bundles are retained outside Git at
`/tmp/agentboard-media-native-61139-results.tar.gz` (68 MB). No production service
or existing simulator was changed.
