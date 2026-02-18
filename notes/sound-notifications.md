# Sound Notifications

Agentboard can play audio notifications when session status changes, helping you stay aware of agent activity without constantly watching the screen.

## Settings

Enable sound notifications in **Settings → Notifications**:

| Setting | Description |
|---------|-------------|
| **Permission Sound** | Plays a short ping when any session needs permission to proceed |
| **Idle Sound** | Plays a chime when a session finishes working and becomes idle |

Both settings are **off by default** and can be toggled independently.

## Sound Design

Sounds are generated using the Web Audio API (no external files):

- **Permission ping**: Higher-pitched tone (880Hz) with quick attack - designed to grab attention
- **Idle chime**: Two-tone chord (440Hz + 550Hz) - pleasant completion sound

## Status Transitions

Sounds trigger on specific status transitions:

| Transition | Sound | When it happens |
|------------|-------|-----------------|
| `*` → `permission` | Permission ping | Agent hits a permission prompt (tool approval, file write, etc.) |
| `working` → `waiting` | Idle chime | Agent finishes processing and awaits user input |

## Technical Notes

- Sounds play regardless of tab focus (unlike browser notifications)
- AudioContext is lazily initialized on first sound play to comply with browser autoplay policies
- Sound playback errors are silently ignored (e.g., if blocked by browser policy)
