# Controlled 4040 rollout

Deployed 2026-10-26 from runtime source `7bbe0c8` and regression commit `3fd8bcb`. Binary SHA-256: `63f239c03b1c98d50dc8d1e2c39d818deae3176b273a6fd2d4778b5d5ea50966`. The previous release and service configuration are retained for rollback. No database rollback was performed.

All 27 pre-swap tmux panes remained present. Served HTML exactly matched the prepared release assets. Local and Tailscale HTTP returned 200.

The reported large session returned its first indexed snapshot/items in 44.85 ms. Discovery caught up in 8,303.75 ms while the newly started server also indexed active sessions. The finite stream ended ready, with 758 items, 80 frames, and 44,740 total bytes. These are live cached-index catch-up measurements, not a cold-disk benchmark.

A simultaneous catalog connection received all 15 scheduled heartbeat replies. Maximum measured round trip was 8.74 ms. This measured a local client during catch-up, not cellular latency.

A separate real-media probe verified HTTP 200 for thumbnails, image next/previous round-trip consistency, a bounded Links page, link search, and Tailscale access. It sent no terminal input.

The browser and native simulator validation preceded deployment. A physical iPhone on cellular and installed Home Screen mode remain unverified. Existing tabs should reload to pick up the new UI.
