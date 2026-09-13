import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionStore,
  getInterruptedCall,
  resolveInterruptedCall,
  reconstructHistory,
  FORMAT_VERSION,
  type SessionEvent,
} from "../src/session/store.js";

let dir: string;
let store: SessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "maxi-session-"));
  store = new SessionStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SessionStore round-trip", () => {
  it("creates a session with a format-version header and a uuid id", async () => {
    const id = await store.createSession();
    expect(id).toBeTruthy();
    const events = await store.readAll(id);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("session-meta");
    if (events[0].type === "session-meta") {
      expect(events[0].key).toBe("formatVersion");
      expect(events[0].value).toBe(FORMAT_VERSION);
    }
  });

  it("appends events and readAll reconstructs the identical array", async () => {
    const id = await store.createSession();
    await store.append(id, { type: "user-message", text: "hello" });
    await store.append(id, { type: "assistant-message", text: "hi there" });
    await store.append(id, {
      type: "tool-call",
      callId: "c1",
      toolName: "readFile",
      args: { path: "a.ts" },
    });
    await store.append(id, { type: "tool-result", callId: "c1", ok: true, output: "content" });

    const events = await store.readAll(id);
    expect(events).toHaveLength(5);
    expect(events.map((e) => e.type)).toEqual([
      "session-meta",
      "user-message",
      "assistant-message",
      "tool-call",
      "tool-result",
    ]);
    // seq is monotonically increasing and matches the line index.
    events.forEach((e, i) => expect(e.seq).toBe(i));
    expect(events.every((e) => e.sessionId === id)).toBe(true);
  });

  it("returns [] for a nonexistent session", async () => {
    expect(await store.readAll("does-not-exist")).toEqual([]);
  });

  it("list returns created session ids", async () => {
    const a = await store.createSession();
    const b = await store.createSession();
    const ids = await store.list();
    expect(ids).toContain(a);
    expect(ids).toContain(b);
  });

  it("round-trips plan lifecycle events in the JSONL log", async () => {
    const id = await store.createSession();
    await store.append(id, {
      type: "plan-created",
      goal: "Build a feature",
      stepCount: 2,
      planId: "plan-1",
    });
    await store.append(id, {
      type: "plan-advanced",
      planId: "plan-1",
      stepId: "step-1",
      to: "in-progress",
    });
    await store.append(id, {
      type: "plan-rewritten",
      oldPlanId: "plan-1",
      newPlanId: "plan-2",
      carriedVerified: 1,
    });
    await store.append(id, { type: "plan-updated", planId: "plan-2", revision: 2 });

    const events = await store.readAll(id);
    const planEvents = events.filter((e) => e.type.startsWith("plan-"));
    expect(planEvents.map((e) => e.type)).toEqual([
      "plan-created",
      "plan-advanced",
      "plan-rewritten",
      "plan-updated",
    ]);
    const created = planEvents[0];
    if (created.type === "plan-created") {
      expect(created.goal).toBe("Build a feature");
      expect(created.stepCount).toBe(2);
      expect(created.planId).toBe("plan-1");
    }
    const advanced = planEvents[1];
    if (advanced.type === "plan-advanced") {
      expect(advanced.stepId).toBe("step-1");
      expect(advanced.to).toBe("in-progress");
    }
    const rewritten = planEvents[2];
    if (rewritten.type === "plan-rewritten") {
      expect(rewritten.oldPlanId).toBe("plan-1");
      expect(rewritten.newPlanId).toBe("plan-2");
      expect(rewritten.carriedVerified).toBe(1);
    }
    const updated = planEvents[3];
    if (updated.type === "plan-updated") {
      expect(updated.revision).toBe(2);
    }
  });
});

describe("SessionStore.fork", () => {
  it("copies all events into a new session with a forkedFrom marker", async () => {
    const id = await store.createSession();
    await store.append(id, { type: "user-message", text: "u1" });
    await store.append(id, { type: "assistant-message", text: "a1" });

    const forkId = await store.fork(id);
    expect(forkId).not.toBe(id);

    const forked = await store.readAll(forkId);
    // original 3 events (header + user + assistant) + forkedFrom marker
    expect(forked).toHaveLength(4);
    expect(forked[0].type).toBe("session-meta");
    expect(forked[1].type).toBe("user-message");
    expect(forked[2].type).toBe("assistant-message");
    const marker = forked[3];
    expect(marker.type).toBe("session-meta");
    if (marker.type === "session-meta") {
      expect(marker.key).toBe("forkedFrom");
      expect(marker.value).toBe(id);
    }
    // Copied events are re-owned by the fork.
    expect(forked.slice(0, 3).every((e) => e.sessionId === forkId)).toBe(true);
  });

  it("respects the newSeqBoundary to branch at an event index", async () => {
    const id = await store.createSession();
    await store.append(id, { type: "user-message", text: "u1" });
    await store.append(id, { type: "assistant-message", text: "a1" });
    await store.append(id, { type: "user-message", text: "u2" });

    // Branch after the first 2 events (header + u1) — excludes a1 and u2.
    const forkId = await store.fork(id, 2);
    const forked = await store.readAll(forkId);
    expect(forked).toHaveLength(3); // 2 copied + marker
    expect(forked[1].type).toBe("user-message");
    if (forked[1].type === "user-message") expect(forked[1].text).toBe("u1");
    expect(forked.some((e) => e.type === "assistant-message")).toBe(false);
  });
});

describe("reconstructHistory", () => {
  it("rebuilds user/assistant texts only, ignoring tool events", () => {
    const events: SessionEvent[] = [
      { seq: 0, ts: 1, sessionId: "s", type: "session-meta", key: "formatVersion", value: "1" },
      { seq: 1, ts: 2, sessionId: "s", type: "user-message", text: "u1" },
      { seq: 2, ts: 3, sessionId: "s", type: "tool-call", callId: "c", toolName: "bash", args: {} },
      { seq: 3, ts: 4, sessionId: "s", type: "tool-result", callId: "c", ok: true, output: "o" },
      { seq: 4, ts: 5, sessionId: "s", type: "assistant-message", text: "a1" },
    ];
    expect(reconstructHistory(events)).toEqual([
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ]);
  });
});

describe("getInterruptedCall", () => {
  it("returns null when every tool-call has a matching tool-result", () => {
    const events: SessionEvent[] = [
      { seq: 0, ts: 1, sessionId: "s", type: "tool-call", callId: "c1", toolName: "bash", args: {} },
      { seq: 1, ts: 2, sessionId: "s", type: "tool-result", callId: "c1", ok: true, output: "o" },
      { seq: 2, ts: 3, sessionId: "s", type: "tool-call", callId: "c2", toolName: "readFile", args: {} },
      { seq: 3, ts: 4, sessionId: "s", type: "tool-result", callId: "c2", ok: true, output: "o" },
    ];
    expect(getInterruptedCall(events)).toBeNull();
  });

  it("returns the most recent tool-call lacking a tool-result", () => {
    const events: SessionEvent[] = [
      { seq: 0, ts: 1, sessionId: "s", type: "tool-call", callId: "c1", toolName: "bash", args: {} },
      { seq: 1, ts: 2, sessionId: "s", type: "tool-result", callId: "c1", ok: true, output: "o" },
      { seq: 2, ts: 3, sessionId: "s", type: "tool-call", callId: "c2", toolName: "bash", args: {} },
    ];
    const interrupted = getInterruptedCall(events);
    expect(interrupted).not.toBeNull();
    expect(interrupted?.type).toBe("tool-call");
    if (interrupted?.type === "tool-call") expect(interrupted.callId).toBe("c2");
  });

  it("returns null for an empty event list", () => {
    expect(getInterruptedCall([])).toBeNull();
  });
});

describe("resolveInterruptedCall", () => {
  it("reruns read-only tools", () => {
    const ev: SessionEvent = { seq: 0, ts: 1, sessionId: "s", type: "tool-call", callId: "c", toolName: "readFile", args: {} };
    expect(resolveInterruptedCall(ev)).toBe("rerun");
  });

  it("skips side-effecting tools (bash)", () => {
    const ev: SessionEvent = { seq: 0, ts: 1, sessionId: "s", type: "tool-call", callId: "c", toolName: "bash", args: {} };
    expect(resolveInterruptedCall(ev)).toBe("skip");
  });

  it("skips file-write tools", () => {
    const ev: SessionEvent = { seq: 0, ts: 1, sessionId: "s", type: "tool-call", callId: "c", toolName: "writeFile", args: {} };
    expect(resolveInterruptedCall(ev)).toBe("skip");
  });

  it("skips unknown tools (defaults to side-effecting)", () => {
    const ev: SessionEvent = { seq: 0, ts: 1, sessionId: "s", type: "tool-call", callId: "c", toolName: "someUnknownTool", args: {} };
    expect(resolveInterruptedCall(ev)).toBe("skip");
  });

  it("skips non-tool-call events", () => {
    const ev: SessionEvent = { seq: 0, ts: 1, sessionId: "s", type: "user-message", text: "x" };
    expect(resolveInterruptedCall(ev)).toBe("skip");
  });
});

describe("idempotency key on tool-call events", () => {
  it("every tool-call event carries a unique callId", async () => {
    const id = await store.createSession();
    await store.append(id, { type: "tool-call", callId: "c1", toolName: "bash", args: {} });
    await store.append(id, { type: "tool-call", callId: "c2", toolName: "readFile", args: {} });
    const events = await store.readAll(id);
    const calls = events.filter((e) => e.type === "tool-call");
    expect(calls).toHaveLength(2);
    const callIds = calls.map((e) => (e.type === "tool-call" ? e.callId : ""));
    expect(callIds[0]).toBeTruthy();
    expect(callIds[1]).toBeTruthy();
    expect(new Set(callIds).size).toBe(2);
  });
});

describe("permissions (POSIX only)", () => {
  it("creates the session dir with 0o700 and files with 0o600", async () => {
    if (process.platform === "win32") {
      // Windows uses ACLs; mode is a no-op. Skip.
      return;
    }
    const id = await store.createSession();
    await store.append(id, { type: "user-message", text: "x" });
    const { statSync } = await import("node:fs");
    const dirMode = statSync(dir).mode & 0o777;
    const fileMode = statSync(join(dir, `${id}.jsonl`)).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });
});
