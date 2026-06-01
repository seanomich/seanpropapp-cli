# Auto-start on Linux

The bridge has to be running for your browser session at https://prop.seanoneill.com to reach your local Claude / Codex CLI. `seanpropapp autostart install` writes a per-user systemd unit so the bridge starts at login and restarts if it crashes.

This uses the systemd `--user` instance, so no root is needed.

## What the install command runs

`seanpropapp autostart install` does two things:

1. Writes `~/.config/systemd/user/seanpropapp-bridge.service`:
   ```ini
   [Unit]
   Description=SeanPropApp local bridge
   After=network.target

   [Service]
   ExecStart=seanpropapp bridge --foreground
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=default.target
   ```
2. Enables + starts it:
   ```sh
   systemctl --user enable --now seanpropapp-bridge.service
   ```

`Restart=always` means systemd restarts the bridge whenever it exits.

## Manual install fallback

```sh
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/seanpropapp-bridge.service <<'UNIT'
[Unit]
Description=SeanPropApp local bridge
After=network.target

[Service]
ExecStart=seanpropapp bridge --foreground
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now seanpropapp-bridge.service
```

If `seanpropapp` isn't on the systemd user $PATH, replace `ExecStart=seanpropapp ...` with the absolute path from `which seanpropapp`.

## Uninstall

```sh
seanpropapp autostart uninstall
```

or manually:

```sh
systemctl --user disable --now seanpropapp-bridge.service
rm ~/.config/systemd/user/seanpropapp-bridge.service
systemctl --user daemon-reload
```

## Troubleshooting

**`Failed to connect to bus: No such file or directory`.**
You're on a headless server or in a container without a user systemd instance. Either run the bridge from a terminal multiplexer (tmux / screen) instead, or enable lingering so the user manager starts at boot:
```sh
sudo loginctl enable-linger $USER
```

**Unit starts but exits immediately; `systemctl --user status seanpropapp-bridge` shows exit code 1.**
Check `journalctl --user -u seanpropapp-bridge -e` for the actual error. Two common causes: the `seanpropapp` binary not being on systemd's $PATH (fix by editing the unit to use an absolute path), and the bridge port 17492-17500 being fully occupied by another process.

**`enable-linger` works but the bridge still isn't reachable after a reboot.**
Confirm the unit is enabled in the user-session graph: `systemctl --user is-enabled seanpropapp-bridge`. If it says `disabled`, re-run `systemctl --user enable seanpropapp-bridge`.
