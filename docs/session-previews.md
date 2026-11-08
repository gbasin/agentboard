# Session previews

Open the shared media pill at the top-right of the terminal, then select **Previews** beside
**Media** and **Links**. Agentboard discovers HTML paths, localhost app URLs, and
Codex visualization markers in assistant replies. It loads preview listings in
bounded pages through the same worker-backed index as media and links.

Desktop previews open in a resizable side pane. Mobile previews fill the screen
and provide a **Terminal** back button. Closing and reopening the same preview
preserves its page state. Use **Reload** to load changes or **Open original** for a separate browser tab.

For assistant-shared web links, select **Links**, then **Preview** beside a link.
The page loads directly from its host only when selected. Tailscale addresses
require a Tailscale connection on the viewing device. Web links do not generate
server-side thumbnails. If a site blocks embedding, use **Open original**. HTTP
pages cannot be embedded in an HTTPS dashboard; the viewer offers the original
link instead. Links to the dashboard itself also open separately.

Previews use temporary ports on Agentboard's host, including its Tailscale
interface. These ports must be reachable from the viewing device; exposing only
Agentboard's main port through a reverse proxy does not expose previews. Local
app assets, API requests, and WebSockets are proxied. Apps that hardcode a
localhost origin may require configuration to use the viewer's origin.

Preview pages use a separate browser origin and cannot access Agentboard's APIs.
Cookies still share hostname scope across ports. Run trusted previews on this
hostname. HTML assets are restricted to the report directory; hidden paths,
non-web files, and symlinks outside that directory are blocked.

Codex visualization fragments use a matching standalone export or the installed
visualize skill's Python renderer. Set `AGENTBOARD_VISUALIZE_RENDERER` to use a
renderer installed elsewhere. Local interactions work; ChatGPT-specific actions
such as sending a follow-up message are unavailable. SSH-only remote session
files are not transferred.

## Saved thumbnails

Opening a preview starts one background screenshot capture. The list shows the
saved screenshot on a later visit. A saved screenshot does not prove that the
source file or app is still available. It records the first open, not later edits.

Capture uses Chrome or Chromium installed on the Agentboard host. Set
`AGENTBOARD_PREVIEW_BROWSER` to the browser executable if automatic detection
fails. Without a browser, previews retain their icons and still open normally.
Each capture uses a fresh browser profile. It does not use your signed-in profile.

The capture limit is one browser process at a time with a 15-second timeout.
The cache holds up to 256 images or 32 MiB in `output-thumbnails` under the
Agentboard data directory. Remove that directory to discard saved screenshots.
Wildcard paths such as `fm-*.html` are excluded from discovery. A missing file
must be restored or shared again at its current path before it can open.
