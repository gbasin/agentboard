# Shared Media / Links / Previews panel

The existing terminal pill opens one panel with three labeled tabs and counts.
Links uses Untitled UI's `Link01Icon`. Previews uses its `BrowserIcon`. External
open actions retain `LinkExternal01Icon`. No separate Outputs strip is added.

Preview listings use the worker-backed media index and bounded pages. Opening a
preview validates its source record and digest, then serves it on an isolated
origin. Desktop uses a resizable side pane; mobile uses a fullscreen viewer.

Visual checks cover the shared panel, desktop preview, mobile preview, and picker
opened over a mobile preview. The screenshots come from Playwright regressions
and a separate headless dev-browser session with a real transcript and HTML file.
The separate browser check exercised the HTML button and changed viewport size
while the preview remained open.

Regression coverage includes tab switching, existing link search and copy,
image lightbox navigation, desktop resizing, mobile input suspension, preserved
terminal and preview state, external tabs, live app assets/API/WebSockets,
visualization markers, stale references, and rejected cross-origin API requests.

Temporary preview ports remain required for remote viewing. This change does
not configure preview hostnames, DNS, or an HTTPS reverse proxy.
