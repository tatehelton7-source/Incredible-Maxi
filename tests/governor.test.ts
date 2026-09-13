import { describe, it, expect, vi } from "vitest";
import { SessionGovernor } from "../src/agent/governor.js";

describe("SessionGovernor", () => {
  it("allows calls up to the tool-call ceiling and blocks exactly at the boundary", () => {
    const governor = new SessionGovernor({ maxToolCalls: 5 });
    for (let i = 0; i < 5; i++) {
      expect(governor.checkToolCall()).toEqual({ ok: true });
    }
    // 6th call is blocked; the 5th was allowed.
    const sixth = governor.checkToolCall();
    expect(sixth.ok).toBe(false);
    if (!sixth.ok) {
      expect(sixth.reason).toContain("tool-call ceiling");
    }
    expect(governor.state()).toBe("blocked");
  });

  it("returns the same reason consistently once blocked", () => {
    const governor = new SessionGovernor({ maxToolCalls: 1 });
    governor.checkToolCall();
    const first = governor.checkToolCall();
    const second = governor.checkToolCall();
    expect(first).toEqual(second);
    if (!first.ok && !second.ok) {
      expect(first.reason).toBe(second.reason);
    }
  });

  it("reset re-enables the governor after a breach", () => {
    const governor = new SessionGovernor({ maxToolCalls: 1 });
    governor.checkToolCall();
    expect(governor.checkToolCall().ok).toBe(false);
    expect(governor.state()).toBe("blocked");

    governor.reset();
    expect(governor.state()).toBe("ok");
    expect(governor.checkToolCall()).toEqual({ ok: true });
  });

  it("blocks on the token ceiling", () => {
    const governor = new SessionGovernor({ maxTokens: 100 });
    governor.recordTokens(60);
    expect(governor.checkToolCall().ok).toBe(true);
    governor.recordTokens(60);
    const result = governor.checkToolCall();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("token ceiling");
    }
  });

  it("estimates tokens via recordTokens without provider metadata", () => {
    const governor = new SessionGovernor({ maxTokens: 10 });
    // chars/4 estimation: 40 chars → 10 tokens → exactly at ceiling.
    governor.recordTokens(Math.ceil(40 / 4));
    const result = governor.checkToolCall();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("token ceiling");
    }
  });

  it("blocks on the wall-clock ceiling", () => {
    vi.useFakeTimers();
    try {
      const governor = new SessionGovernor({ maxWallClockMs: 1000 });
      expect(governor.checkToolCall().ok).toBe(true);
      vi.advanceTimersByTime(1001);
      const result = governor.checkToolCall();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("wall-clock ceiling");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("invokes onBreach with context when a ceiling is hit", () => {
    const onBreach = vi.fn();
    const governor = new SessionGovernor({ maxToolCalls: 2, onBreach });
    governor.checkToolCall();
    governor.checkToolCall();
    governor.checkToolCall();
    expect(onBreach).toHaveBeenCalledTimes(1);
    const info = onBreach.mock.calls[0][0];
    expect(info.reason).toContain("tool-call ceiling");
    expect(typeof info.elapsedMs).toBe("number");
    expect(info.toolCalls).toBe(2);
  });

  it("defaults to 30 min wall-clock, 100 tool calls, 500k tokens", () => {
    const governor = new SessionGovernor();
    for (let i = 0; i < 100; i++) {
      expect(governor.checkToolCall().ok).toBe(true);
    }
    expect(governor.checkToolCall().ok).toBe(false);
  });
});
