# Read-only SSH attachment validation

2026-11-08, m5p iPhone 17 Pro Simulator, iOS 26.4.

Topology: Simulator on `100.82.11.21` → HTTP/WebSocket backend on `100.82.11.20:4152` → real system SSH to `100.82.11.21` → private tmux fixture `ab-ios-parity`, window `native-live-one`.

The second backend used a new local data/socket directory at `/tmp/ab-ios-ssh-validation`. Remote attach was enabled and remote management disabled. Its process-local PATH supplied an SSH adapter that delegates to `/usr/bin/ssh`, retaining normal authentication and host verification. The adapter prepends the remote command with a socket-existence check and `TMUX_TMPDIR=/tmp/ab-ios-parity`, preventing access to the production tmux socket. No persistent SSH configuration or credentials changed.

`TailnetSmokeTests/testExistingSessionOverTailnet` passed in 12 seconds. It searched for the explicit private fixture, selected the `remote:100.82.11.21:ab-ios-parity:@1` row, waited for enabled terminal input and visible terminal output, then navigated back. It sent no terminal input and changed no session metadata.

Backend logs record `ssh_session_created`, `ssh_attach_spawn` and `ssh_proxy_ready` with a real remote TTY. Result bundle on m5p: `/tmp/ab-real-ssh-attach.xcresult`; test log: `/tmp/ab-real-ssh-attach.log`. Backend log on this Mac: `/tmp/ab-ios-ssh-validation/backend.log`.

This verifies cross-host Tailscale connectivity and successful native SSH-backed attachment/read/navigation with an isolated command environment. It does not certify arbitrary SSH configurations, remote management, physical-device networking or remote clipboard/image acceptance.
