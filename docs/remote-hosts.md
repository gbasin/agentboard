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

## Choose what the UI can do

Remote sessions are view-only by default. Two variables widen that.

| Setting | View | Type and resize | Create, kill, rename |
| --- | --- | --- | --- |
| Default | Yes | No | No |
| `AGENTBOARD_REMOTE_ALLOW_ATTACH=true` | Yes | Yes | No |
| `AGENTBOARD_REMOTE_ALLOW_CONTROL=true` | Yes | Yes | Yes |

`AGENTBOARD_REMOTE_ALLOW_CONTROL=true` also enables attach, unless you set `AGENTBOARD_REMOTE_ALLOW_ATTACH` explicitly.

With control enabled, the **New Session** dialog has a host picker. Kill and rename work only for sessions that Agentboard created on the remote host. Sessions that Agentboard discovered there cannot be killed or renamed.

## Settings

| Variable | Default | Effect |
| --- | --- | --- |
| `AGENTBOARD_REMOTE_HOSTS` | unset | Comma-separated SSH hosts. Names that are not valid hostnames are dropped with a warning. |
| `AGENTBOARD_REMOTE_ALLOW_ATTACH` | follows `ALLOW_CONTROL` | Set `true` to allow terminal input, resize, and copy-mode on remote sessions. |
| `AGENTBOARD_REMOTE_ALLOW_CONTROL` | `false` | Set `true` to allow create, kill, and rename on remote hosts. |
| `AGENTBOARD_REMOTE_POLL_MS` | `2000` | Interval between polls of each host. |
| `AGENTBOARD_REMOTE_TIMEOUT_MS` | `4000` | Timeout for each SSH command. |
| `AGENTBOARD_REMOTE_STALE_MS` | 3 × poll interval, minimum `15000` | Time without a successful poll before a host is marked stale. |
| `AGENTBOARD_REMOTE_SSH_OPTS` | unset | Extra `ssh` options, space-separated. |
| `AGENTBOARD_HOST` | machine hostname | Label for the local host. |

Agentboard always passes `-o BatchMode=yes -o ConnectTimeout=3`. You do not need to add them to `AGENTBOARD_REMOTE_SSH_OPTS`.

## Speed up polling with SSH multiplexing

Each poll opens an SSH connection to every remote host. SSH connection multiplexing reuses one connection and reduces the cost of each poll from about 200-500 ms to about 5 ms.

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

Remote sessions do not have these features:

- File and image uploads.
- The media rail.
- Session recovery. Each machine's recovery catalog covers its own local sessions only.
