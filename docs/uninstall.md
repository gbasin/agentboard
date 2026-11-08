# Uninstall

## Remove Agentboard

1. If you installed a service, remove it. See the uninstall section of [launchd/README.md](../launchd/README.md#uninstall) (macOS) or [systemd/README.md](../systemd/README.md#uninstall) (Linux).
2. Stop Agentboard if it still runs.
3. Remove the package.
   - Homebrew: run `brew uninstall agentboard`. To also remove the tap, run `brew untap gbasin/tap`.
   - npm: run `npm uninstall -g @gbasin/agentboard`.

## Keep tmux when you uninstall with Homebrew

Homebrew removes dependencies that no other formula needs. If Agentboard was the only formula that needed tmux, `brew uninstall agentboard` also removes tmux. Your sessions keep running, but you cannot attach to them without tmux.

To keep tmux, use one of these:

- Run `HOMEBREW_NO_AUTOREMOVE=1 brew uninstall agentboard`.
- Run `brew install tmux` after the uninstall.

## What an uninstall leaves in place

- `~/.agentboard`, which holds the database, the log, and other data. To delete it, run `rm -rf ~/.agentboard`.
- Your tmux sessions and the programs in them. They keep running.
- Files uploaded through the board, in `/tmp` and in the system temporary directory.
- The tmux server options that Agentboard set (`set-clipboard on`, `@agentboard-server-id`). They last until the tmux server stops.
- A `tailscale serve` configuration, if you created one.
- A systemd drop-in in `~/.config/systemd/user/agentboard.service.d/`, if you created one.
