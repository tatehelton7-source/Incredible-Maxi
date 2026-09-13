import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Spinner } from "../../src/ui/spinner.js";

describe("Animation Themes", () => {
  let spinner: Spinner;
  let originalIsTTY: boolean | undefined;
  let originalNoColor: string | undefined;

  beforeEach(() => {
    originalIsTTY = process.stdout.isTTY;
    originalNoColor = process.env.NO_COLOR;
    // Mock isTTY by defining property
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    vi.stubEnv("NO_COLOR", "");
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, configurable: true });
    if (originalNoColor !== undefined) {
      process.env.NO_COLOR = originalNoColor;
    } else {
      delete process.env.NO_COLOR;
    }
    vi.unstubAllEnvs();
  });

  it("should create spinner with default theme", () => {
    const spinner = new Spinner();
    expect(spinner.isEnabled()).toBe(true);
  });

  it("should create spinner with custom theme", () => {
    const spinner = new Spinner({ theme: "pulse" });
    expect(spinner.isEnabled()).toBe(true);
  });

  it("should support pulse theme", () => {
    const spinner = new Spinner({ theme: "pulse" });
    expect(spinner.isEnabled()).toBe(true);
    spinner.setTheme("rotate");
    expect(spinner.isEnabled()).toBe(true);
  });

  it("should support rotate theme", () => {
    const spinner = new Spinner({ theme: "rotate" });
    expect(spinner.isEnabled()).toBe(true);
  });

  it("should support wave theme", () => {
    const spinner = new Spinner({ theme: "wave" });
    expect(spinner.isEnabled()).toBe(true);
  });

  it("should disable when NO_COLOR is set", () => {
    vi.stubEnv("NO_COLOR", "1");
    const spinner = new Spinner();
    expect(spinner.isEnabled()).toBe(false);
  });

  it("should disable when not in TTY", () => {
    vi.spyOn(process.stdout, "isTTY", "get").mockReturnValue(false);
    const spinner = new Spinner();
    expect(spinner.isEnabled()).toBe(false);
  });

  it("should start and stop without errors", () => {
    const spinner = new Spinner({ enabled: true });
    expect(() => spinner.start("test")).not.toThrow();
    expect(() => spinner.stop()).not.toThrow();
  });

  it("should update text", () => {
    const spinner = new Spinner({ enabled: true });
    expect(() => spinner.update("new text")).not.toThrow();
  });

  it("should succeed and fail without errors", () => {
    const spinner = new Spinner({ enabled: true });
    expect(() => spinner.succeed("done")).not.toThrow();
    expect(() => spinner.fail("error")).not.toThrow();
  });

  it("should change theme", () => {
    const spinner = new Spinner({ theme: "dots" });
    expect(() => spinner.setTheme("pulse")).not.toThrow();
    expect(() => spinner.setTheme("rotate")).not.toThrow();
    expect(() => spinner.setTheme("wave")).not.toThrow();
  });
});