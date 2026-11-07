# PWA installation

You can install Agentboard as a Progressive Web App (PWA). The installed app opens in its own window with no browser toolbar. On a phone, it opens full screen from the home screen.

## Requirements

- **A production server.** Use an installed release (Homebrew, npm, or a release binary) or a built source checkout (`bun run build`, then `bun run start`). The development server (`bun run dev`) never registers the service worker, so it cannot produce an install.
- **A secure origin.** The browser registers the service worker only on HTTPS, or on `localhost` or `127.0.0.1` on the same machine. For another device, this means HTTPS.
- **A certificate that the device trusts.** If the certificate is self-signed and not trusted, the page can load after you accept the warning, but the service worker does not register. A Tailscale certificate is trusted by all common browsers.

Agentboard serves HTTPS only when you set both `TLS_CERT` and `TLS_KEY`. The production server does not look for certificate files on its own.

## Option A: Agentboard serves HTTPS with a Tailscale certificate

Use this option when your devices are on the same tailnet. Agentboard serves HTTPS on its own port, on both `127.0.0.1` and your Tailscale address.

### 1. Enable HTTPS certificates for your tailnet

1. Open the **DNS** page of the Tailscale admin console.
2. Enable **MagicDNS** if it is not already on.
3. Under **HTTPS Certificates**, select **Enable HTTPS**.

Tailscale certificates are public. The certificate transparency logs publish your machine name and tailnet name.

### 2. Find the Tailscale command

On Linux, and when `tailscale` is on your `PATH`, use:

```bash
TS=tailscale
```

The macOS app keeps the command inside the app bundle. If `tailscale` is not on your `PATH`, use:

```bash
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
```

On Linux, allow your user to request certificates without `sudo` (one time):

```bash
sudo "$TS" set --operator=$USER
```

### 3. Get the certificate

1. Read your machine's tailnet name. This step needs `jq`.

   ```bash
   TS_NAME=$("$TS" status --json | jq -r '.Self.DNSName | rtrimstr(".")')
   echo "$TS_NAME"
   ```

   The name has the form `<machine>.<tailnet>.ts.net`.

2. Write the certificate and key into the Agentboard data directory.

   ```bash
   mkdir -p ~/.agentboard
   "$TS" cert \
     --cert-file ~/.agentboard/tls-cert.pem \
     --key-file ~/.agentboard/tls-key.pem \
     "$TS_NAME"
   chmod 600 ~/.agentboard/tls-key.pem
   ```

Do not name the variable `HOSTNAME`. Agentboard reads `HOSTNAME` as its bind address.

### 4. Start Agentboard with TLS

```bash
TLS_CERT="$HOME/.agentboard/tls-cert.pem" TLS_KEY="$HOME/.agentboard/tls-key.pem" agentboard
```

From a source checkout, run `bun run build` once, then replace `agentboard` with `bun run start`.

Keep the default `HOSTNAME`. With the default, Agentboard also listens on your Tailscale address, and the TLS settings apply to that listener too. The startup log shows `https://` URLs.

### 5. Open the board

Open `https://<machine>.<tailnet>.ts.net:4040` on the device. Use the full name: the certificate is valid only for that name, not for the IP address or the short machine name.

Then follow [Install the app on your device](#install-the-app-on-your-device).

### Renew the certificate

Tailscale certificates expire after 90 days. `tailscale cert` does not renew them on its own.

1. Run the `"$TS" cert` command from step 3 again.
2. Restart Agentboard. The server reads the certificate files only when it starts.

### Run as a service with TLS

| Service | TLS support |
| --- | --- |
| launchd, release mode | Not supported. The installer refuses `TLS_CERT` and `TLS_KEY` in `~/.agentboard/service-env.json`, and its health checks use HTTP. Use source mode, or keep the service on HTTP and use [Option B](#option-b-tailscale-serve-terminates-https). |
| launchd, source mode | Supported. Put the variables in a `.env.local` file in the checkout. |
| systemd | Supported. Use a drop-in or a `.env.local` file in the checkout. |

**launchd source mode.** The service runs `bun run start` in the checkout, and Bun loads `.env.local` from that directory.

1. Create `.env.local` in the checkout. Use absolute paths.

   ```bash
   TLS_CERT=/Users/<you>/.agentboard/tls-cert.pem
   TLS_KEY=/Users/<you>/.agentboard/tls-key.pem
   ```

2. Restart the service.

   ```bash
   launchctl kickstart -k gui/$(id -u)/com.agentboard
   ```

**systemd.** Add a drop-in.

1. Open the drop-in editor.

   ```bash
   systemctl --user edit agentboard
   ```

2. Add these lines. Use absolute paths.

   ```ini
   [Service]
   Environment=TLS_CERT=/home/<you>/.agentboard/tls-cert.pem
   Environment=TLS_KEY=/home/<you>/.agentboard/tls-key.pem
   ```

3. Restart the service.

   ```bash
   systemctl --user restart agentboard
   ```

The systemd service also starts Bun in the checkout, so a `.env.local` file there works as well.

## Option B: Tailscale Serve terminates HTTPS

Use this option to keep Agentboard on HTTP, for example with the launchd release service. Tailscale Serve accepts HTTPS on port 443 of your tailnet name and forwards requests to Agentboard on `127.0.0.1`. Tailscale provisions the certificate for Serve; you do not run `tailscale cert`.

1. Do steps 1 and 2 of [Option A](#option-a-agentboard-serves-https-with-a-tailscale-certificate).
2. Start Agentboard without `TLS_CERT` and `TLS_KEY`.
3. Start Serve in the background.

   ```bash
   "$TS" serve --bg 4040
   ```

4. Open `https://<machine>.<tailnet>.ts.net` on the device. There is no port in this URL.

To stop forwarding, run `"$TS" serve reset`.

Serve forwards the browser's original `Host` header to Agentboard. The origin check therefore accepts it, and you do not need `AGENTBOARD_ALLOWED_ORIGINS`. Agentboard still listens on `http://<tailscale-ip>:4040` as well. That address works for the board, but not for an install.

## Option C: Chrome flag, no HTTPS

Chrome can treat one HTTP origin as secure. Use this only for a device that you control.

1. Open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`.
2. Add the board's origin, for example `http://100.101.102.103:4040`.
3. Set the flag to **Enabled**.
4. Select **Relaunch**.

The production server is still required. Safari on iOS has no equivalent setting.

## Install the app on your device

- **iOS Safari:** open the board URL, select **Share**, then select **Add to Home Screen**.
- **Android Chrome:** open the board URL, open the menu, then select **Install app** or **Add to Home screen**.
- **Desktop Chrome or Edge:** open the board URL, then select the install icon in the address bar.

## What the PWA does

- **Standalone window.** The manifest sets `display: standalone`, so the app opens without browser controls.
- **App shell cache.** The service worker precaches the built JavaScript, CSS, HTML, icons, and fonts.
- **Automatic updates.** The service worker activates a new version on its own. The page checks for a new version every 5 minutes and each time the app returns to the foreground.

## What the PWA does not do

- **It does not work offline.** The board needs a live connection to the server. The service worker does not cache `/api` responses or the `/ws` WebSocket.
- **It sends no push notifications.** Agentboard has no push or system notification code. Notification sounds play only while the board is open.
- **It has no app store package.**

## Troubleshooting

**The install option does not appear.**

1. Confirm that you opened the production server, not the development server on port 5173.
2. Confirm that the URL starts with `https://` and uses the name in the certificate.
3. Open DevTools, then **Application** > **Manifest**. The Agentboard manifest must be listed.
4. Open **Application** > **Service Workers**. `sw.js` must be activated.

**The console shows "An SSL certificate error occurred when fetching the script".** The device does not trust the certificate. Use a Tailscale certificate, or install your own certificate authority on the device.

**The browser shows a certificate error after about 90 days.** Renew the certificate, then restart Agentboard. See [Renew the certificate](#renew-the-certificate).

**The service worker interferes with the WebSocket.** The service worker excludes `/api` and `/ws`. If a problem remains, open **Application** > **Service Workers** and select **Unregister**.
