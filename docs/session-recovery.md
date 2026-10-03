# Session recovery

Agentboard saves a local managed session before starting its terminal. Its stable ID, chosen name, project, command, and lifecycle remain available even if no provider log exists. Renames and stop requests commit immediately. Reopening uses the saved conversation where one is available; shell process state cannot be recreated after reboot.

## Use Session recovery

Open **History** in the desktop header or **History & recovery** on mobile. When interrupted sessions exist, a notice above the session list opens the same panel.

- **Interrupted** means the saved process disappeared from a successfully queried tmux server. Failed queries preserve the last confirmed state and surface in recovery health.
- Select **Reopen** to relaunch a session. Running sessions are reused; reopen requests are idempotent.
- Hibernate and archive remain available through the session API. Pinning a saved session is independent of lifecycle.

The sidebar hibernating/history rails are unchanged. The catalog is additive metadata — it does not replace the provider log pipeline.

## Settings

| Behavior | Default |
| --- | --- |
| Automatic reopening of interrupted sessions | Off |
| Terminal previews | Off; optional last 80 lines, capped at 32 KB, timestamped |

Both are stored under `persistence_settings` and can be changed through `PUT /api/library/settings`.

## Durability and implementation

- `board_sessions` owns the name and lifecycle. `session_runs` records each launch with an idempotency key; `session_conversations` keeps earlier provider associations; `session_events` retains the timeline.
- Creation commits its intent before spawn. A temporary tmux window name contains board/run IDs from the creation command itself; user options and the intended name follow in the same tmux command sequence. Startup can adopt a pane even if tagging or acknowledgment was interrupted.
- A tmux server has a random lifetime ID. Reused window numbers after reboot cannot claim an earlier run. Reconciliation does not kill an unexpected pane. Explicit hibernate/archive requests identify and terminate only their tagged run.
- Window identity rides the same `list-windows` enumeration that refreshes the session list; the tmux server epoch is cached per server PID. Reconciliation runs against that snapshot, so an empty or pid-less enumeration cannot interrupt anything.
- SQLite uses WAL, FULL synchronization, a five-second busy timeout, and macOS fullfsync. A `VACUUM INTO` snapshot precedes the additive catalog migration, and newer unsupported catalog versions are rejected.
- The serving process owns its database through an exclusive SQLite transaction in a separate lock database beside the data file. The OS releases this lock after a crash; canonical paths and reference counting handle multiple connections in one process. Test instances use separate databases, provider roots, and private tmux sockets.

## Validation and limits

Automated coverage includes backend SIGKILL/restart, private tmux server replacement, naming before logs exist, reused window IDs, a crash between pane creation and tagging, repeated reopen requests, a failed hibernate intent surviving a crash, pagination, and migration idempotence. Automatic reopening and timestamped terminal previews are covered by the isolated server tests. Additional regressions cover competing process ownership and directory symlinks.

SIGKILL tests do not simulate loss of the operating system's disk cache. A controlled VM power-loss test has not been performed; storage hardware and filesystem guarantees still matter.

The durable catalog covers this server's managed sessions. External or remote terminals continue to use their existing discovery behavior; each upgraded remote Agentboard owns its own local catalog.

## Upgrade

Build the frontend and restart Agentboard using your normal installation method. Initial startup snapshots the existing database, imports provider metadata, and adopts running managed windows. Run one backend per database.
