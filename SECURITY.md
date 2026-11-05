# Security Policy

## Reporting Security Issues

We take the security of Agentboard seriously. If you believe you have found a security vulnerability, please report it to us privately. **Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Instead, please report them via:
- [GitHub Security Advisory](https://github.com/gbasin/agentboard/security/advisories/new)

### Reporting Process
1. **Submit Report**: Use the above channel to submit your report
2. **Response Time**: We will acknowledge receipt of your report within 14 business days
3. **Collaboration**: We will collaborate with you to understand and validate the issue
4. **Resolution**: We will work on a fix and coordinate the release process

### Disclosure Policy
- Please provide detailed reports with reproducible steps
- Include the version/commit hash where you discovered the vulnerability
- Allow us a 90-day security fix window before any public disclosure
- After a patch is released, allow 30 days for users to update before public disclosure (for a total of 120 days max)
- Share any potential mitigations or workarounds if known

## Supported Versions

Security fixes go into the next release. All release channels below are built from the same tag.

| Version | Supported |
|---------|-----------|
| Latest commit on the default branch | Yes |
| Latest npm release (`@gbasin/agentboard` and its platform packages) | Yes |
| Latest Homebrew formula (`gbasin/tap/agentboard`) | Yes |
| Latest binaries attached to a [GitHub release](https://github.com/gbasin/agentboard/releases) | Yes |
| All other versions | No |

## Threat model

Agentboard is a web interface to your tmux server. A client that can connect to it can do anything that you can do in a terminal, as your user. The sections below describe who can connect and what a connection allows.

### No authentication

Agentboard has no login, no tokens, and no user accounts. The server does not check who a client is. Network reachability is the only access control.

### Listeners

| Listener | When it exists | Protocol |
| --- | --- | --- |
| `HOSTNAME`:`PORT` | Always. The default is `127.0.0.1:4040`. | HTTPS if `TLS_CERT` and `TLS_KEY` are set, else HTTP. |
| Tailscale IPv4 address:`PORT` | `HOSTNAME` is exactly `127.0.0.1`, and `tailscale ip -4` returns an address at startup (5-second timeout). | Same as the main listener. |
| `127.0.0.1`:random port | The terminal relay is on (the default; `AGENTBOARD_TERMINAL_RELAY=0` turns it off). | Always HTTP. |

- **`HOSTNAME`.** The server binds to the address in `HOSTNAME`. `0.0.0.0` listens on all interfaces, including your LAN. A `HOSTNAME` that equals the machine hostname is ignored, because containers and some CI images export it automatically. The server then binds `127.0.0.1`.
- **Tailscale.** The server runs `tailscale` from `PATH`, then `/Applications/Tailscale.app/Contents/MacOS/Tailscale`. It looks once, at startup. It does not add this listener for any other `HOSTNAME`, including `localhost`. With `0.0.0.0`, the main listener already covers the Tailscale interface. Every device that your tailnet access rules let reach this machine can use the board.
- **Internal listener.** With the relay on, the public listener runs in a worker, and the main process serves HTTP on a random loopback port. That port accepts the full HTTP API and `/ws`, with no TLS. Any local user or process on the machine can reach it, as it can reach the main listener on `127.0.0.1`.
- **Development server.** `bun run dev` starts Vite with `--host`, so it listens on all interfaces on port 5173. Vite forwards `/api` and `/ws` to the backend. This exposes the backend to your network whatever `HOSTNAME` says.

### TLS

TLS is opt-in. Set both `TLS_CERT` and `TLS_KEY` to serve HTTPS on the main and Tailscale listeners. The production server does not look for certificate files on its own. See [PWA installation](docs/pwa-install.md) for a working setup.

### What a connected client can do

**WebSocket (`/ws`).** The server accepts 16 client message types.

- **Terminal I/O:** `terminal-attach`, `terminal-detach`, `terminal-input`, `terminal-paste`, `terminal-resize`, `terminal-resume`, `terminal-ack`, `tmux-cancel-copy-mode`, `tmux-check-copy-mode`. A client can read the screen of any session on the board and type into it.
- **Session control:** `session-create` (any project directory and any command, run as your user), `session-kill`, `session-rename`, `session-refresh`, `session-wake` (runs the agent's resume command), `session-hibernate`, `session-move-to-history`.
- **Keepalive:** `ping`.

Limits on these messages:

- **Discovered sessions.** Windows from your other tmux sessions appear on the board. A client can attach to them and type into them. It can kill them only when `ALLOW_KILL_EXTERNAL=true`.
- **Remote hosts.** For sessions on [remote hosts](docs/remote-hosts.md), `AGENTBOARD_REMOTE_ALLOW_ATTACH=true` allows attach and input. `AGENTBOARD_REMOTE_ALLOW_CONTROL=true` allows create and kill, and it also turns on attach unless `AGENTBOARD_REMOTE_ALLOW_ATTACH` is set. Both default to `false`. Remote create accepts only hosts listed in `AGENTBOARD_REMOTE_HOSTS`. Remote kill applies only to sessions that Agentboard created.
- **Kill rate limit.** Each connection can kill a limited number of sessions in a row.

**HTTP.** The server has 32 API routes, plus the static frontend files.

| Group | Routes | What they allow |
| --- | --- | --- |
| Uploads | `POST /api/paste-file`, `POST /api/paste-image` | Write a file to the host. `paste-file` accepts any type up to 40 MB and writes it to a new `agentboard-upload-*` directory (mode 0700) in the system temporary directory, with file mode 0600. `paste-image` accepts PNG, JPEG, GIF, and WebP up to `AGENTBOARD_PASTE_IMAGE_MAX_BYTES` (default 40 MB) and writes `/tmp/paste-<time>-<random>.<ext>` with the default file mode, which is world-readable under the usual umask. Agentboard does not delete uploaded files. |
| Directory browsing | `GET /api/directories` | List the subdirectory names of any directory that your user can read. Up to 200 entries per request. File names are not listed. |
| Transcripts | `GET /api/session-preview/:id`, `GET /api/session-media/:id`, `.../items`, `.../neighbors` | Read up to 500 lines of a session's agent transcript, and images, documents, and links from it. Media reads are limited to the session's own transcript and its subagent transcripts. |
| Host clipboard (macOS) | `GET /api/clipboard-file-path` | Read the host clipboard. Returns a copied file's path, or writes a copied image to a temporary PNG and returns its path. |
| Session library | `GET /api/library`, `GET /api/library/:id`, `GET /api/library/health`, `PUT /api/library/settings`, `POST /api/library/:id/resume`, `PATCH /api/library/:id` | Search saved sessions, resume one (runs its resume command), rename, pin, or archive. |
| Settings | `GET` and `PUT` for `/api/settings/tmux-mouse-mode`, `terminal-colors`, `prefer-window-name`, `synced`, `history-max-age-hours`, `inactive-max-age-hours` | Change server-wide settings. `tmux-mouse-mode` sets the tmux `mouse` option on the managed session and its grouped sessions. |
| GitHub | `POST /api/pr-info`, `GET /api/pr-checks` | Run `gh` with your credentials to read the state, title, author, and checks of up to 50 pull request URLs per request, including private ones that you can see. |
| Status | `GET /api/health`, `GET /api/sessions`, `GET /api/server-info` | Read the session list, the port, the Tailscale address, and the protocol. |
| Client log | `POST /api/client-log` | Write an event to the server log. |

### Requests from web pages

Browsers add their own limits, but the server enforces little in this version.

- **WebSocket.** The server does not check the `Origin` header on `/ws`. A web page on any site, open in a browser that can reach the server, can open the WebSocket and send any message above, including `session-create` with a command.
- **Session library writes.** Non-GET requests under `/api/library` with an `Origin` that does not match the request host get 403.
- **Other writes.** The other `POST` routes accept cross-site requests. `PUT` and `PATCH` from another site need a CORS preflight, and the server does not answer one, so browsers do not send them.
- **Reading responses.** The server sends no CORS headers, so a page on another site cannot read HTTP responses.

### Server-wide side effects

- **tmux `set-clipboard`.** In `pty` terminal mode, Agentboard sets the server option `set-clipboard on` for your whole tmux server. It does not restore the old value. Set `AGENTBOARD_TMUX_SET_CLIPBOARD=0` to prevent this.
- **tmux server identity.** Agentboard sets the global user option `@agentboard-server-id` once per tmux server.
- **Grouped sessions.** Browser connections create `<TMUX_SESSION>-ws-*` sessions in your tmux server. They are removed on disconnect and pruned at startup.

### Data on disk

| Data | Location | Mode |
| --- | --- | --- |
| Data directory | `~/.agentboard` (`AGENTBOARD_DATA_DIR`) | 0700. Set on the directory that holds the database. |
| Database, with `-wal` and `-shm` files | `agentboard.db` | 0600 |
| Log file | `agentboard.log` (`LOG_FILE`) | Your umask. Usually 0644. |
| Other files (lock, mirrors, recovery data) | In the data directory | Varies. Protected by the directory mode. |

The database holds session names, project paths, transcript paths, last prompts, pull request links, settings, and terminal previews when preview capture is on. The log holds event metadata: session names, project paths, tmux targets, errors, and events that browsers post to `/api/client-log`. Kill requests are logged with the client's IP address and user agent. A `LOG_FILE` outside the data directory is not protected by the directory mode.

### Supply chain

- **npm.** The release workflow ([release.yml](.github/workflows/release.yml)) publishes the main package and the four platform packages with `npm publish --provenance`. It authenticates with GitHub OIDC trusted publishing, not a stored npm token.
- **Binaries and Homebrew.** The same workflow builds the binaries, attaches them to the GitHub release, and writes the Homebrew formula with the SHA-256 of each tarball. The binaries are not signed and have no provenance attestation.
- **Actions.** The build and release workflows pin third-party actions to commit SHAs. The release-please workflow uses a version tag.
- **Dependency scanner.** `bun run deps:risk` runs [scripts/dependency-risk.ts](scripts/dependency-risk.ts). It combines `bun audit` advisories with `bun outdated` version lag. It fails at `high` severity by default. CI runs it with `--threshold critical`, so CI fails only on critical advisories.

---
Last updated: November 2026
