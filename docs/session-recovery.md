# Session recovery

Agentboard saves each session it starts before it starts the terminal. The session's ID, name, project, command, and state stay available after a crash or a reboot, even when the agent has not written a transcript yet. Renames and stop requests are saved at once. When you reopen a session, Agentboard resumes the saved conversation where one exists. It cannot recreate the state of a shell process after a reboot.

Recovery adds to the sidebar; it does not replace it. The **Hibernating** and **History** sections work as before.

How the catalog works internally is in [architecture.md](architecture.md#session-recovery-catalog).

## Reopen interrupted sessions

A session is **interrupted** when its process disappeared from a tmux server that Agentboard queried successfully. A failed query does not interrupt anything: Agentboard keeps the last confirmed state and reports the problem in the recovery notice.

1. Open **Session recovery**. Use one of these:
   - The clock button in the sidebar controls.
   - The clock button next to **New Session** in the mobile session drawer.
   - The notice above the session list. It shows when interrupted sessions exist, and you can dismiss it.
2. Find the session. Each row shows the name, the project, how long ago it was active, and why it stopped.
3. Select **Reopen**.

If the session is still running, Reopen opens it instead of starting a second copy. If the conversation is still running in a window of another tmux session, Reopen refuses, so the conversation never runs twice.

The panel lists up to 100 interrupted sessions. A session whose launch failed is counted in the notice but is not listed in the panel.

Hibernate and archive are available through the API (`PATCH /api/library/<id>` with `{"state": "hibernating"}` or `{"state": "archived"}`). Pinning a saved session does not change its state.

## Settings

| Setting | Default | Effect when on |
| --- | --- | --- |
| `autoResume` | Off | At server startup, reopens every interrupted session once. |
| `capturePreviews` | Off | Saves a text preview of each running session's terminal: the visible screen plus 80 lines of scrollback, up to 32,768 characters, with a timestamp. Agentboard refreshes up to 10 sessions every 5 seconds. The UI does not show previews; `GET /api/library/<id>` returns them. |

The Settings dialog has no control for these settings. Change them through the API:

```bash
curl -X PUT http://localhost:4040/api/library/settings \
  -H 'Content-Type: application/json' \
  -d '{"autoResume": true}'
```

## Limits

- Recovery reopens only the sessions that this server manages in its own tmux session. Windows in other tmux sessions are not saved or reopened. An agent conversation that runs in such a window can still appear in the catalog as an archived record, because Agentboard imports the conversations that it knows from transcripts.
- Sessions on remote hosts are not saved by this server. An Agentboard that runs on the remote host keeps its own catalog.
- Saving survives a killed server process. It has not been tested against a power loss. Your disk and filesystem must keep data that was already written.
- Run one Agentboard server per database. A second server on the same database refuses to start.

## Upgrade

Build the frontend and restart Agentboard with your normal installation method. The first start of a version that has session recovery, on a database from a version that did not, does these steps:

1. Saves a copy of the database, if the database already holds sessions. The copy is `<database file>.before-catalog-schema`, beside the database file: `~/.agentboard/agentboard.db.before-catalog-schema` by default. If a file with that name exists, Agentboard adds `.1`, `.2`, and so on. A new installation has no copy.
2. Imports the existing conversations.
3. Adopts the running windows of the managed tmux session.

Later starts skip step 1.

A database from a newer Agentboard version is refused; it does not downgrade.
