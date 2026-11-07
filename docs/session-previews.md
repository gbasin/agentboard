# Session previews

Open the shared media pill at the top-right of the terminal, then select **Previews** beside
**Media** and **Links**. Agentboard discovers HTML paths, localhost app URLs, and
Codex visualization markers in assistant replies. It loads preview listings in
bounded pages through the same worker-backed index as media and links.

Desktop previews open in a resizable side pane. Mobile previews fill the screen
and provide a **Terminal** back button. Closing and reopening the same preview
preserves its page state. Use **Reload** to load file changes or **Open output in
new tab** for a separate browser tab.

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
