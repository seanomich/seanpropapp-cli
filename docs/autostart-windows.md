# Auto-start on Windows

The bridge has to be running for your browser session at https://prop.seanoneill.com to reach your local Claude / Codex CLI. On Windows the recommended supervisor is Task Scheduler with an "At log on" trigger.

> **v0.1.0-alpha note.** Full auto-install via Task Scheduler XML is deferred to v1.4.1. For this release, `seanpropapp autostart install` prints the one-line `schtasks` command you need to run yourself. The command below is what it prints.

## What to run

Open an elevated PowerShell or `cmd.exe` (Run as administrator) and:

```cmd
schtasks /create /SC ONLOGON /RL HIGHEST /TN "SeanPropApp Bridge" /TR "seanpropapp bridge --foreground"
```

If `seanpropapp.exe` isn't on Task Scheduler's $PATH, replace the `/TR` value with the absolute path you get from `where seanpropapp`.

This creates a task that runs `seanpropapp bridge --foreground` every time you log on, with elevated privileges. The bridge will be reachable on http://127.0.0.1:17492 after the next login.

## Manual install via Task Scheduler GUI

1. Open Task Scheduler (`Win` + search "Task Scheduler").
2. Right click "Task Scheduler Library", choose "Create Task".
3. **General** tab: name `SeanPropApp Bridge`. Check "Run with highest privileges".
4. **Triggers** tab: New, choose "At log on", "Any user".
5. **Actions** tab: New, "Start a program", program = `seanpropapp` (or the absolute path), arguments = `bridge --foreground`.
6. **Settings** tab: check "If the task fails, restart every: 1 minute" (Task Scheduler's KeepAlive equivalent).
7. Save.

## Uninstall

```cmd
schtasks /delete /TN "SeanPropApp Bridge" /F
```

Or remove it from the Task Scheduler GUI.

## Troubleshooting

**`schtasks` says "Access is denied".**
You need an elevated terminal. Right-click cmd.exe / PowerShell and choose "Run as administrator".

**Task is registered but the bridge doesn't start at login.**
Task Scheduler runs the task in a non-interactive session by default. Open the task's Properties > General and change "Configure for:" to "Windows 10/11". If the bridge needs to interact with a console window (it doesn't for normal operation), check "Run only when user is logged on" instead of "Run whether user is logged on or not".

**The bridge starts but the browser still says "Bridge not reachable".**
Check Windows Defender Firewall: the bridge listens on `127.0.0.1` only (localhost), so it should not need an inbound rule, but some endpoint-protection suites override this. Test the bridge by running `seanpropapp doctor` in a separate terminal; if `doctor` reports the bridge as reachable, the issue is browser-side (try a hard reload).
