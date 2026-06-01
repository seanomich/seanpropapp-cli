# Auto-start on macOS

The bridge has to be running for your browser session at https://prop.seanoneill.com to reach your local Claude / Codex CLI. The `seanpropapp autostart install` command writes a launchd LaunchAgent so the bridge starts at login and restarts if it crashes.

## What the install command runs

`seanpropapp autostart install` does two things:

1. Writes `~/Library/LaunchAgents/com.seanpropapp.bridge.plist` with:
   - `Label` = `com.seanpropapp.bridge`
   - `ProgramArguments` = `[seanpropapp, bridge, --foreground]`
   - `RunAtLoad` = `true`
   - `KeepAlive` = `true`
   - `StandardOutPath` = `/tmp/seanpropapp-bridge.out.log`
   - `StandardErrorPath` = `/tmp/seanpropapp-bridge.err.log`
2. Bootstraps the agent for your current GUI session:
   ```sh
   launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.seanpropapp.bridge.plist
   ```

After this the bridge will be running on http://127.0.0.1:17492 (or the next free port in 17492-17500) on every login.

## Manual install fallback

If you'd rather not run the auto-install:

```sh
mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/com.seanpropapp.bridge.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.seanpropapp.bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>seanpropapp</string>
    <string>bridge</string>
    <string>--foreground</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/seanpropapp-bridge.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/seanpropapp-bridge.err.log</string>
</dict>
</plist>
PLIST
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.seanpropapp.bridge.plist
```

If `seanpropapp` isn't on the launchd $PATH (a common gotcha), replace the first `<string>seanpropapp</string>` with the absolute path you get from `which seanpropapp`.

## Uninstall

```sh
seanpropapp autostart uninstall
```

or manually:

```sh
launchctl bootout gui/$UID/com.seanpropapp.bridge
rm ~/Library/LaunchAgents/com.seanpropapp.bridge.plist
```

## Troubleshooting

**`launchctl bootstrap` fails with "service already loaded".**
Run `seanpropapp autostart uninstall` first, then try install again. The bootout step is idempotent and safe even if nothing is loaded.

**The bridge isn't running after login even though the plist is there.**
Check `/tmp/seanpropapp-bridge.err.log` for a stack trace. The most common cause is launchd not finding `seanpropapp` on its $PATH. Edit the plist and replace the `seanpropapp` argument with the absolute path from `which seanpropapp`.

**`launchctl: command not found`.**
This is built into macOS and on $PATH for every user. If you don't have it, you're probably inside a heavily-customized shell environment. Open Terminal.app (not iTerm/your custom shell) and run the command from there.
