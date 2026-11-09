# Harness logos

Simulator captures from m5p-2, iPhone 17 / iOS 27.2, November 9, 2026.

- `light.png` and `dark.png`: actual native catalog with a temporary loopback fixture containing Claude, Codex, Pi, Devin, Grok, Oh My Pi and an unknown harness. Names and sessions are illustrative. No production session was modified.
- `dark-large.png`: maximum Dynamic Type catalog, captured before scrolling to metadata.
- `library-light.png`: saved-session row from the existing NativeGlassUITests fixture.

The SVG paths and viewBoxes come from `src/client/components/AgentIcon.tsx`. Native assets preserve vector representation. Monochrome marks use adaptive template rendering; Oh My Pi retains the orange connector in both appearances. Pin and status indicators remain separate.

Validation: Simulator build-for-testing succeeded. Both NativeGlassUITests workflows passed in light/large and dark/accessibility-XXXL (four executions total), including session metadata, activity, pull requests, terminal keyboard input, media navigation and Library. Result bundles remain on m5p-2 at `/tmp/ab-harness-light.xcresult` and `/tmp/ab-harness-dark.xcresult`. This focused check does not replace the wider release acceptance matrix.
