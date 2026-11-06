# Sound notifications

Agentboard can play a sound when a session needs your attention. Use it to follow your agents without watching the screen.

Sounds play in the browser tab that shows the board. Agentboard does not send system notifications, and it plays nothing when no board tab is open.

## Turn sounds on

1. Open **Settings**.
2. Select the **Notifications** page.
3. Turn on **Permission sound**, **Idle sound**, or both.

Both are off by default. Select **Test** next to a setting to hear its sound.

These settings are shared. Agentboard stores them on the server, so a change in one browser applies to every browser that opens the same board.

## When a sound plays

| Sound | Setting | Plays when a session changes |
| --- | --- | --- |
| Short high ping (880 Hz) | **Permission sound** | from any status to *permission*: the agent shows an approval prompt or a question menu. |
| Soft two-tone chime (440 Hz and 550 Hz) | **Idle sound** | from *working* to *waiting*: the agent stopped producing output. |

A session goes from *working* to *waiting* when its terminal output stays unchanged for the working grace period (4 seconds by default; see `AGENTBOARD_WORKING_GRACE_MS` in [configuration.md](configuration.md#tuning-and-diagnostics)). The chime therefore plays a few seconds after the agent stops.

Sounds apply to every session on the board, including discovered and remote sessions. A session that first appears in the list does not play a sound. Each sound plays at most once every 500 ms, so many sessions that change together produce one sound.

## Browser audio rules

Browsers play audio only after you interact with the page. When a sound setting is on, Agentboard unlocks audio on your next click, key press, or tap in the board. Turning a setting on also unlocks audio.

After the computer sleeps, Safari can stop audio output silently. Agentboard detects a wake (the tab becomes visible again, the page is restored from the back-forward cache, or the clock jumps by more than 15 seconds) and resets its audio. The next click, key press, or tap unlocks audio again.

Agentboard does not check whether the tab has focus. Whether a background tab can play a sound depends on the browser. Mobile browsers usually suspend audio in a background tab. If the browser blocks playback, the sound is skipped without an error.
