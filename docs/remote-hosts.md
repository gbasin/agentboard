# Remote hosts

Agentboard can show tmux sessions from other machines next to your local ones. It reaches each machine over SSH, so the remote machine needs no Agentboard install.

## Requirements

- `ssh` on the Agentboard host.
- Key-based SSH access to each remote host that works without a prompt. Agentboard runs `ssh` with `BatchMode=yes`, so a host that asks for a password or passphrase fails.
- `tmux` on each remote host.

## Enable remote hosts

1. Confirm that SSH works without a prompt:

   ```bash
   ssh -o BatchMode=yes mba tmux list-windows -a
   ```

2. Start Agentboard with the host list:

   ```bash
   AGENTBOARD_REMOTE_HOSTS=mba,carbon agentboard
   ```

Remote sessions appear in the session list with a host badge. They show live status (working, waiting, needs permission), which Agentboard reads from the pane content over SSH. Use the filter button to show or hide hosts.

`AGENTBOARD_REMOTE_HOSTS` accepts plain hostnames only. A value such as `user@host` or `host:2222` is dropped with a warning. To set a user or port, define a host alias in `~/.ssh/config` and list the alias.

## Choose what the UI can do

By default, remote sessions are listed with their status, but you cannot open their terminal. Two variables widen that.

| Setting | Listed with status | Open the terminal, type, resize | Create, kill, rename |
| --- | --- | --- | --- |
| Default | Yes | No | No |
| `AGENTBOARD_REMOTE_ALLOW_ATTACH=true` | Yes | Yes | No |
| `AGENTBOARD_REMOTE_ALLOW_CONTROL=true` | Yes | Yes | Yes |

Only the exact value `true` enables either variable. `AGENTBOARD_REMOTE_ALLOW_CONTROL=true` also enables attach, unless you set `AGENTBOARD_REMOTE_ALLOW_ATTACH` explicitly.

With control enabled, the **New Session** dialog has a host picker. Agentboard creates remote sessions as windows in the remote tmux session named `TMUX_SESSION` (default `agentboard`). Kill and rename work only for windows in that session. Windows in other remote tmux sessions cannot be killed or renamed.

## Settings

| Variable | Default | Effect |
| --- | --- | --- |
| `AGENTBOARD_REMOTE_HOSTS` | unset | Comma-separated SSH hosts. Names that are not valid hostnames are dropped with a warning. |
| `AGENTBOARD_REMOTE_ALLOW_ATTACH` | follows `ALLOW_CONTROL` | Set `true` to allow terminal input, resize, and copy-mode on remote sessions. |
| `AGENTBOARD_REMOTE_ALLOW_CONTROL` | `false` | Set `true` to allow create, kill, and rename on remote hosts. |
| `AGENTBOARD_REMOTE_POLL_MS` | `2000` | Interval between polls of each host. |
| `AGENTBOARD_REMOTE_TIMEOUT_MS` | `4000` | Timeout for each status poll. Create, kill, and rename use a fixed 10 seconds. |
| `AGENTBOARD_REMOTE_STALE_MS` | 3 × poll interval, minimum `15000` | Time without a completed poll before a host is treated as stale. The sessions of a stale host are hidden. |
| `AGENTBOARD_REMOTE_SSH_OPTS` | unset | Extra `ssh` options, space-separated. |
| `AGENTBOARD_HOST` | machine hostname | Label for the local host. |

Agentboard always passes `-o BatchMode=yes -o ConnectTimeout=3`. You do not need to add them to `AGENTBOARD_REMOTE_SSH_OPTS`.

## Speed up polling with SSH multiplexing

Each poll opens an SSH connection to every remote host. SSH connection multiplexing reuses one connection for the status polls, which removes the connection setup from each poll. Terminal attach and session commands always open their own connection.

1. Add this to `~/.ssh/config` on the Agentboard host:

   ```
   Host *
       ControlMaster auto
       ControlPath ~/.ssh/sockets/%r@%h-%p
       ControlPersist 600
   ```

2. Create the sockets directory:

   ```bash
   mkdir -p ~/.ssh/sockets && chmod 700 ~/.ssh/sockets
   ```

## Limits

Agentboard does not read agent transcripts on remote hosts. Remote sessions do not have these features:

- The last prompt, pull requests, the media rail, and subagent activity.
- Hibernate, Wake, and History.
- Session recovery. The recovery catalog covers local sessions only.
- File and image uploads.
- Copy from the tmux paste buffer to the browser clipboard.
