import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NotificationSystem } from "../../src/notification.js";

describe("Notification System", () => {
  let notifications: NotificationSystem;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("NO_COLOR", "");
    notifications = new NotificationSystem({ enabled: true });
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("should create notification system with default enabled", () => {
    const notifications = new NotificationSystem();
    expect(notifications.isEnabled()).toBe(true);
  });

  it("should disable when NO_COLOR is set", () => {
    vi.stubEnv("NO_COLOR", "1");
    const notifications = new NotificationSystem();
    expect(notifications.isEnabled()).toBe(false);
  });

  it("should notify subagent started", () => {
    notifications.started("test-agent");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Subagent "test-agent" started')
    );
  });

  it("should notify subagent completed", () => {
    notifications.completed("test-agent", 2300);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Subagent "test-agent" completed in 2.3s')
    );
  });

  it("should notify model switched", () => {
    notifications.modelSwitched("openai", "gpt-4o");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Model switched to openai/gpt-4o")
    );
  });

  it("should notify model issue", () => {
    notifications.modelIssue("Connection timeout");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Model issue: Connection timeout")
    );
  });

  it("should notify info", () => {
    notifications.info("Test info message");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Test info message")
    );
  });

  it("should notify warning", () => {
    notifications.warn("Test warning");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Test warning")
    );
  });

  it("should notify error", () => {
    notifications.error("Test error");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Test error")
    );
  });

  it("should not output when disabled", () => {
    const disabled = new NotificationSystem({ enabled: false });
    disabled.started("test-agent");
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("should not output when NO_COLOR is set", () => {
    vi.stubEnv("NO_COLOR", "1");
    const disabled = new NotificationSystem();
    disabled.started("test-agent");
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("should toggle enabled state", () => {
    const notifications = new NotificationSystem({ enabled: true });
    expect(notifications.isEnabled()).toBe(true);
    notifications.setEnabled(false);
    expect(notifications.isEnabled()).toBe(false);
    notifications.setEnabled(true);
    expect(notifications.isEnabled()).toBe(true);
  });
});