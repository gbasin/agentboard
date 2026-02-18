# PWA Installation

Agentboard can be installed as a Progressive Web App (PWA) for a full-screen, app-like experience with no browser chrome — ideal for a tmux controller on mobile devices.

## Requirements

PWA installation requires the page to be served over **HTTPS** (or localhost). Choose the setup that matches your environment.

---

## Option A: Tailscale HTTPS (Recommended)

If you access Agentboard over Tailscale, you can use Tailscale's built-in HTTPS certificates.

### 1. Enable cert generation (one-time)

```bash
sudo tailscale set --operator=$USER
```

### 2. Generate the certificate

```bash
HOSTNAME=$(tailscale status --self --json | grep -o '"DNSName":"[^"]*"' | cut -d'"' -f4 | sed 's/\.$//')
tailscale cert \
  --cert-file ~/.agentboard/tls-cert.pem \
  --key-file ~/.agentboard/tls-key.pem \
  "$HOSTNAME"
```

### 3. Restart Agentboard

The dev server automatically detects certs in `~/.agentboard/` and enables HTTPS. Just restart:

```bash
bun run dev
```

You'll see `https://` URLs in the output. Access Agentboard at:

```
https://<your-machine>.tail<xxxxx>.ts.net:5173
```

### 4. Install the PWA

- **Android Chrome:** Navigate to the URL → three-dot menu → "Install app"
- **iOS Safari:** Navigate to the URL → Share → "Add to Home Screen"
- **Desktop Chrome/Edge:** Navigate to the URL → install icon in address bar

---

## Option B: Without Tailscale (HTTP)

If you're not using Tailscale, Agentboard serves over HTTP. Browsers require HTTPS for PWA installation, but you can work around this with a Chrome flag.

### Android / Desktop Chrome

1. Open `chrome://flags` in Chrome
2. Search for `unsafely-treat-insecure-origin-as-secure`
3. Add your Agentboard URL, e.g. `http://192.168.1.100:5173`
4. Set to **Enabled** and tap **Relaunch**
5. Navigate to your Agentboard URL
6. Three-dot menu → "Install app" or "Add to Home Screen"

### iOS Safari

iOS Safari does not support Chrome flags. You'll need HTTPS via one of:
- A reverse proxy (nginx/caddy) with a self-signed or Let's Encrypt cert
- Tailscale (see Option A)

---

## What the PWA Does

- **Standalone display:** Launches full-screen with no browser chrome
- **App shell caching:** Caches static assets (JS, CSS, HTML, fonts, icons) for faster loads
- **Auto-update:** Service worker silently updates when new versions are deployed

## What the PWA Does NOT Do

- **No offline mode:** Agentboard requires a live tmux/WebSocket connection. The service worker only caches static assets, not API responses.
- **No push notifications**
- **No app store packaging**

## Troubleshooting

**"Install" option doesn't appear:**
- Verify the page is served over HTTPS (or the Chrome flag is set)
- Check DevTools → Application → Manifest — it should show the Agentboard manifest
- Check DevTools → Application → Service Workers — should be registered

**iOS doesn't show full-screen:**
- Must use Share → "Add to Home Screen" (bookmarks don't work)
- Verify `display: standalone` is in the manifest

**Service worker interferes with WebSocket:**
- The service worker is configured to exclude `/api` and `/ws` routes
- If issues persist, unregister the service worker in DevTools → Application → Service Workers
