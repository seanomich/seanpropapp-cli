import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { installAutostart, uninstallAutostart } from "../autostart.js";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "seanpropapp-autostart-"));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("installAutostart", () => {
  it("writes a launchd plist on darwin (dry-run)", async () => {
    const res = await installAutostart({
      platform: "darwin",
      home,
      dryRun: true,
      binPath: "/opt/sp/bin/seanpropapp",
      stdout: () => {},
      stderr: () => {},
    });
    expect(res.ok).toBe(true);
    if (res.ok && res.action === "install" && res.path) {
      const plist = await fs.readFile(res.path, "utf8");
      expect(plist).toContain("com.seanpropapp.bridge");
      expect(plist).toContain("/opt/sp/bin/seanpropapp");
      expect(plist).toContain("<key>RunAtLoad</key>");
      expect(plist).toContain("<key>KeepAlive</key>");
    }
  });

  it("writes a systemd unit on linux (dry-run)", async () => {
    const res = await installAutostart({
      platform: "linux",
      home,
      dryRun: true,
      binPath: "/opt/sp/bin/seanpropapp",
      stdout: () => {},
      stderr: () => {},
    });
    expect(res.ok).toBe(true);
    if (res.ok && res.action === "install" && res.path) {
      const unit = await fs.readFile(res.path, "utf8");
      expect(unit).toContain("ExecStart=/opt/sp/bin/seanpropapp bridge --foreground");
      expect(unit).toContain("Restart=always");
      expect(unit).toContain("WantedBy=default.target");
    }
  });

  it("prints schtasks instructions on win32 (no fs write)", async () => {
    let captured = "";
    const res = await installAutostart({
      platform: "win32",
      home,
      binPath: "C:\\sp\\seanpropapp.exe",
      stdout: (s) => {
        captured += s;
      },
      stderr: () => {},
    });
    expect(res.ok).toBe(true);
    expect(captured).toMatch(/schtasks/);
    expect(captured).toMatch(/SeanPropApp Bridge/);
    if (res.ok && res.action === "install") {
      expect(res.manual?.[0]).toMatch(/schtasks \/create/);
    }
  });

  it("rejects unsupported platforms cleanly", async () => {
    const res = await installAutostart({
      platform: "freebsd" as NodeJS.Platform,
      home,
      stdout: () => {},
      stderr: () => {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/unsupported platform/);
  });
});

describe("uninstallAutostart", () => {
  it("removes a previously written plist on darwin (dry-run)", async () => {
    const install = await installAutostart({
      platform: "darwin",
      home,
      dryRun: true,
      stdout: () => {},
      stderr: () => {},
    });
    expect(install.ok).toBe(true);
    const res = await uninstallAutostart({
      platform: "darwin",
      home,
      dryRun: true,
      stdout: () => {},
      stderr: () => {},
    });
    expect(res.ok).toBe(true);
    if (res.ok && res.action === "uninstall" && res.path) {
      await expect(fs.access(res.path)).rejects.toBeTruthy();
    }
  });

  it("removes a previously written systemd unit on linux (dry-run)", async () => {
    await installAutostart({
      platform: "linux",
      home,
      dryRun: true,
      stdout: () => {},
      stderr: () => {},
    });
    const res = await uninstallAutostart({
      platform: "linux",
      home,
      dryRun: true,
      stdout: () => {},
      stderr: () => {},
    });
    expect(res.ok).toBe(true);
  });

  it("is idempotent when no plist exists", async () => {
    const res = await uninstallAutostart({
      platform: "darwin",
      home,
      dryRun: true,
      stdout: () => {},
      stderr: () => {},
    });
    expect(res.ok).toBe(true);
  });

  it("prints schtasks delete on win32", async () => {
    let captured = "";
    const res = await uninstallAutostart({
      platform: "win32",
      home,
      stdout: (s) => {
        captured += s;
      },
      stderr: () => {},
    });
    expect(res.ok).toBe(true);
    expect(captured).toMatch(/schtasks \/delete/);
  });
});
