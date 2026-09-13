import { describe, it, expect } from "vitest";
import { inspectSession, renderSummary } from "../src/session/inspect.js";
import type { SessionEvent } from "../src/session/store.js";

function ev(partial: Omit<SessionEvent, "seq" | "ts" | "sessionId"> & { seq?: number; ts?: number }): SessionEvent {
  return { seq: 0, ts: 0, sessionId: "s", ...partial } as SessionEvent;
}

function baseEvents(): SessionEvent[] {
  return [
    ev({ type: "session-meta", key: "formatVersion", value: "1" }),
    ev({ type: "user-message", text: "hello" }),
    ev({ type: "assistant-message", text: "hi" }),
    ev({ type: "tool-call", callId: "c1", toolName: "bash", args: {} }),
    ev({ type: "tool-result", callId: "c1", ok: true, output: "ok" }),
  ];
}

describe("inspectSession counters", () => {
  it("counts messages, tool calls (total + per-tool), and event count", () => {
    const events = [
      ...baseEvents(),
      ev({ type: "tool-call", callId: "c2", toolName: "readFile", args: {} }),
      ev({ type: "tool-result", callId: "c2", ok: true, output: "x" }),
      ev({ type: "tool-call", callId: "c3", toolName: "bash", args: {} }),
      ev({ type: "tool-result", callId: "c3", ok: true, output: "y" }),
    ];
    const s = inspectSession(events);
    expect(s.eventCount).toBe(events.length);
    expect(s.userMessages).toBe(1);
    expect(s.assistantMessages).toBe(1);
    expect(s.toolCalls.total).toBe(3);
    expect(s.toolCalls.perTool).toEqual({ bash: 2, readFile: 1 });
  });

  it("counts approvals by decision and rule", () => {
    const events = [
      ...baseEvents(),
      ev({ type: "approval-decision", toolName: "bash", decision: "allow", rule: "read-only" }),
      ev({ type: "approval-decision", toolName: "bash", decision: "ask", rule: "mode:always-ask" }),
      ev({ type: "approval-decision", toolName: "bash", decision: "deny", rule: "deny-pattern:rm-r-f" }),
      ev({ type: "approval-decision", toolName: "bash", decision: "ask", rule: "mode:always-ask" }),
    ];
    const s = inspectSession(events);
    expect(s.approvals.allowed).toBe(1);
    expect(s.approvals.asked).toBe(2);
    expect(s.approvals.denied).toBe(1);
    expect(s.approvals.rulesFired).toEqual({
      "read-only": 1,
      "mode:always-ask": 2,
      "deny-pattern:rm-r-f": 1,
    });
  });

  it("counts plan lifecycle events and carried-verified steps", () => {
    const events = [
      ...baseEvents(),
      ev({ type: "plan-created", goal: "g", stepCount: 2, planId: "plan-1" }),
      ev({ type: "plan-advanced", planId: "plan-1", stepId: "s1", to: "verified" }),
      ev({ type: "plan-advanced", planId: "plan-1", stepId: "s2", to: "in-progress" }),
      ev({ type: "plan-rewritten", oldPlanId: "plan-1", newPlanId: "plan-2", carriedVerified: 1 }),
      ev({ type: "plan-advanced", planId: "plan-2", stepId: "s3", to: "failed" }),
    ];
    const s = inspectSession(events);
    expect(s.planEvents.created).toBe(1);
    expect(s.planEvents.advanced).toBe(3);
    expect(s.planEvents.rewritten).toBe(1);
    expect(s.planEvents.carriedVerified).toBe(1);
    expect(s.gates.passed).toBe(1);
    expect(s.gates.failed).toBe(1);
  });

  it("counts governor breaches and resets", () => {
    const events = [
      ...baseEvents(),
      ev({ type: "session-meta", key: "governor-breach", value: "tool-call ceiling (5 calls)" }),
      ev({ type: "session-meta", key: "governor-reset", value: "user" }),
      ev({ type: "session-meta", key: "governor-breach", value: "token ceiling (100 tokens)" }),
    ];
    const s = inspectSession(events);
    expect(s.governor.breaches).toEqual([
      "tool-call ceiling (5 calls)",
      "token ceiling (100 tokens)",
    ]);
    expect(s.governor.resets).toBe(1);
  });

  it("returns zeros for an empty event list", () => {
    const s = inspectSession([]);
    expect(s.eventCount).toBe(0);
    expect(s.userMessages).toBe(0);
    expect(s.toolCalls.total).toBe(0);
    expect(s.approvals.allowed).toBe(0);
    expect(s.planEvents.created).toBe(0);
    expect(s.gates.passed).toBe(0);
    expect(s.governor.breaches).toEqual([]);
    expect(s.interrupted).toBe(false);
  });
});

describe("inspectSession halt reason", () => {
  it("governor breach wins when the most recent governor event is a breach", () => {
    const events = [
      ...baseEvents(),
      ev({ type: "session-meta", key: "governor-breach", value: "tool-call ceiling (5 calls)" }),
    ];
    expect(inspectSession(events).haltReason).toBe("Governor breach: tool-call ceiling (5 calls)");
  });

  it("governor breach is superseded by a later reset", () => {
    const events = [
      ...baseEvents(),
      ev({ type: "session-meta", key: "governor-breach", value: "tool-call ceiling (5 calls)" }),
      ev({ type: "session-meta", key: "governor-reset", value: "user" }),
    ];
    expect(inspectSession(events).haltReason).toBe("Session ended normally or is still running");
  });

  it("stall/escalation when the last plan-advanced event reached blocked", () => {
    const events = [
      ...baseEvents(),
      ev({ type: "plan-created", goal: "g", stepCount: 1, planId: "plan-1" }),
      ev({ type: "plan-advanced", planId: "plan-1", stepId: "s1", to: "in-progress" }),
      ev({ type: "plan-advanced", planId: "plan-1", stepId: "s1", to: "blocked" }),
    ];
    expect(inspectSession(events).haltReason).toBe("Plan step blocked after stall (escalation)");
  });

  it("gate failure loop when the last plan-advanced event reached failed", () => {
    const events = [
      ...baseEvents(),
      ev({ type: "plan-created", goal: "g", stepCount: 1, planId: "plan-1" }),
      ev({ type: "plan-advanced", planId: "plan-1", stepId: "s1", to: "in-progress" }),
      ev({ type: "plan-advanced", planId: "plan-1", stepId: "s1", to: "failed" }),
    ];
    expect(inspectSession(events).haltReason).toBe("Gate failure loop: step failed verification");
  });

  it("user stop when the last event is a user /exit message", () => {
    const events = [
      ...baseEvents(),
      ev({ type: "user-message", text: "/exit" }),
    ];
    expect(inspectSession(events).haltReason).toBe("User stopped the session");
  });

  it("user stop when the last event is a trailing assistant message", () => {
    const events = [
      ...baseEvents(),
      ev({ type: "assistant-message", text: "done" }),
    ];
    expect(inspectSession(events).haltReason).toBe("User stopped the session");
  });

  it("interrupted tool call when a tool-call lacks a result", () => {
    const events = [
      ...baseEvents(),
      ev({ type: "tool-call", callId: "c9", toolName: "bash", args: {} }),
    ];
    const s = inspectSession(events);
    expect(s.interrupted).toBe(true);
    expect(s.haltReason).toBe("Interrupted tool call");
  });

  it("defaults to normal/healthy when no halt signal is present", () => {
    const events = [
      ...baseEvents(),
      ev({ type: "plan-created", goal: "g", stepCount: 1, planId: "plan-1" }),
      ev({ type: "plan-advanced", planId: "plan-1", stepId: "s1", to: "verified" }),
    ];
    expect(inspectSession(events).haltReason).toBe("Session ended normally or is still running");
  });
});

describe("renderSummary", () => {
  it("renders a compact ASCII block with the halt reason", () => {
    const events = [
      ...baseEvents(),
      ev({ type: "session-meta", key: "governor-breach", value: "tool-call ceiling (5 calls)" }),
    ];
    const out = renderSummary(inspectSession(events));
    expect(out).toContain("Session s");
    expect(out).toContain("Halt reason: Governor breach: tool-call ceiling (5 calls)");
    expect(out).toContain("Tool calls: 1");
    expect(out.split("\n").length).toBeLessThanOrEqual(25);
  });

  it("renders per-tool and per-rule breakdowns when present", () => {
    const events = [
      ...baseEvents(),
      ev({ type: "tool-call", callId: "c2", toolName: "readFile", args: {} }),
      ev({ type: "tool-result", callId: "c2", ok: true, output: "x" }),
      ev({ type: "approval-decision", toolName: "bash", decision: "ask", rule: "mode:always-ask" }),
    ];
    const out = renderSummary(inspectSession(events));
    expect(out).toContain("bash=1, readFile=1");
    expect(out).toContain("mode:always-ask=1");
  });
});
