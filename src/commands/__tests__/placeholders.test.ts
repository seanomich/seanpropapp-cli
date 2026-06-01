import { describe, it, expect, vi } from "vitest";
import {
  runAutostartPlaceholder,
  runDoctorPlaceholder,
} from "../placeholders.js";

describe("placeholder commands", () => {
  it("doctor prints Coming in Lane C-Polish", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    runDoctorPlaceholder();
    expect(String(spy.mock.calls[0]?.[0] ?? "")).toMatch(/Lane C-Polish/);
    spy.mockRestore();
  });

  it("autostart prints Coming in Lane C-Polish", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    runAutostartPlaceholder();
    expect(String(spy.mock.calls[0]?.[0] ?? "")).toMatch(/Lane C-Polish/);
    spy.mockRestore();
  });
});
