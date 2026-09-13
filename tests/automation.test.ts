import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AutomationEngine,
  parseCron,
  parseCronField,
  cronMatches,
} from "../src/automation/engine.js";
import type { AgentOrchestrator, AgentRunResult } from "../src/agents/orchestrator.js";

/** Build a minimal fake orchestrator that records calls. */
function createFakeOrchestrator(
  impl?: (agentName: string, prompt: string) => Promise<AgentRunResult>
): AgentOrchestrator {
  return {
    runAgent: vi.fn(async (agentName: string, prompt: string) => {
      if (impl) return impl(agentName, prompt);
      return { text: `ran ${agentName}: ${prompt}`, iterations: 1, toolCalls: 0 };
    }),
    runParallel: vi.fn(),
  } as unknown as AgentOrchestrator;
}

describe("cron parser", () => {
  it("parses a wildcard schedule", () => {
    const s = parseCron("* * * * *");
    expect(s.minute.wildcard).toBe(true);
    expect(s.hour.wildcard).toBe(true);
    expect(s.dayOfMonth.wildcard).toBe(true);
    expect(s.month.wildcard).toBe(true);
    expect(s.dayOfWeek.wildcard).toBe(true);
  });

  it("parses single values, ranges, and lists", () => {
    const s = parseCron("0 9 1-5 1,6 *");
    expect(s.minute.values.has(0)).toBe(true);
    expect(s.hour.values.has(9)).toBe(true);
    expect(s.dayOfMonth.values.has(1)).toBe(true);
    expect(s.dayOfMonth.values.has(5)).toBe(true);
    expect(s.dayOfMonth.values.has(3)).toBe(true);
    expect(s.month.values.has(1)).toBe(true);
    expect(s.month.values.has(6)).toBe(true);
    expect(s.dayOfWeek.wildcard).toBe(true);
  });

  it("rejects schedules with the wrong number of fields", () => {
    expect(() => parseCron("* * * *")).toThrow();
    expect(() => parseCron("* * * * * *")).toThrow();
  });

  it("rejects out-of-range values", () => {
    expect(() => parseCron("60 * * * *")).toThrow();
    expect(() => parseCron("* 24 * * *")).toThrow();
    expect(() => parseCron("* * 32 * *")).toThrow();
    expect(() => parseCron("* * * 13 *")).toThrow();
    expect(() => parseCron("* * * * 7")).toThrow();
  });

  it("rejects invalid tokens", () => {
    expect(() => parseCronField("foo", 0, 59)).toThrow();
    expect(() => parseCron("*/5 * * * *")).toThrow();
  });

  it("matches a date against a schedule", () => {
    const s = parseCron("30 14 * * *");
    expect(cronMatches(s, new Date(2026, 7, 27, 14, 30))).toBe(true);
    expect(cronMatches(s, new Date(2026, 7, 27, 14, 31))).toBe(false);
    expect(cronMatches(s, new Date(2026, 7, 27, 15, 30))).toBe(false);
  });
});

describe("AutomationEngine", () => {
  let dir: string;
  let engine: AutomationEngine;
  let orchestrator: AgentOrchestrator;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "maxi-auto-"));
    orchestrator = createFakeOrchestrator();
    engine = new AutomationEngine(dir, orchestrator);
  });

  afterEach(() => {
    engine.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers and lists jobs", () => {
    const id = engine.registerJob({
      name: "nightly",
      trigger: { type: "cron", schedule: "0 2 * * *" },
      agentName: "coder",
      prompt: "do the thing",
      enabled: true,
    });
    expect(id).toBeTruthy();
    expect(engine.listJobs()).toHaveLength(1);
    expect(engine.getJob(id)?.name).toBe("nightly");
  });

  it("rejects invalid cron schedules at registration", () => {
    expect(() =>
      engine.registerJob({
        name: "bad",
        trigger: { type: "cron", schedule: "not a cron" },
        agentName: "coder",
        prompt: "x",
        enabled: true,
      })
    ).toThrow();
  });

  it("removes a job", () => {
    const id = engine.registerJob({
      name: "tmp",
      trigger: { type: "event", event: "on-command" },
      agentName: "coder",
      prompt: "x",
      enabled: true,
    });
    expect(engine.removeJob(id)).toBe(true);
    expect(engine.listJobs()).toHaveLength(0);
    expect(engine.removeJob(id)).toBe(false);
  });

  it("dispatches event-triggered jobs and records a completed run", async () => {
    const id = engine.registerJob({
      name: "on-save",
      trigger: { type: "event", event: "on-file-change" },
      agentName: "coder",
      prompt: "review the change",
      enabled: true,
    });

    engine.emit("on-file-change");

    // Wait for the async dispatch to settle.
    await vi.waitFor(() => {
      expect(engine.getRuns(id)[0]?.status).toBe("completed");
    });

    const run = engine.getRuns(id)[0];
    expect(run.status).toBe("completed");
    expect(run.result).toContain("review the change");
    expect(run.startedAt).toBeGreaterThan(0);
    expect(run.finishedAt).toBeGreaterThanOrEqual(run.startedAt);
    expect(orchestrator.runAgent).toHaveBeenCalledWith("coder", "review the change");
  });

  it("does not dispatch event jobs for non-matching events", async () => {
    engine.registerJob({
      name: "on-save",
      trigger: { type: "event", event: "on-file-change" },
      agentName: "coder",
      prompt: "x",
      enabled: true,
    });

    engine.emit("on-command");
    await new Promise((r) => setTimeout(r, 20));
    expect(orchestrator.runAgent).not.toHaveBeenCalled();
  });

  it("records a failed run when the job throws", async () => {
    const failing = createFakeOrchestrator(async () => {
      throw new Error("boom");
    });
    const eng = new AutomationEngine(dir, failing);

    const id = eng.registerJob({
      name: "failing",
      trigger: { type: "event", event: "on-command" },
      agentName: "coder",
      prompt: "x",
      enabled: true,
    });

    eng.emit("on-command");
    await vi.waitFor(() => {
      expect(eng.getRuns(id)[0]?.status).toBe("failed");
    });

    const run = eng.getRuns(id)[0];
    expect(run.status).toBe("failed");
    expect(run.error).toBe("boom");
    eng.stop();
  });

  it("persists jobs to .maxi/automations.json", () => {
    engine.registerJob({
      name: "persisted",
      trigger: { type: "cron", schedule: "5 * * * *" },
      agentName: "coder",
      prompt: "x",
      enabled: true,
    });

    const storePath = join(dir, ".maxi", "automations.json");
    expect(existsSync(storePath)).toBe(true);
    const store = JSON.parse(readFileSync(storePath, "utf8"));
    expect(store.jobs).toHaveLength(1);
    expect(store.jobs[0].name).toBe("persisted");
  });

  it("reloads persisted jobs on construction", () => {
    engine.registerJob({
      name: "reload-me",
      trigger: { type: "event", event: "on-command" },
      agentName: "coder",
      prompt: "x",
      enabled: true,
    });
    engine.stop();

    const reloaded = new AutomationEngine(dir, orchestrator);
    expect(reloaded.listJobs()).toHaveLength(1);
    expect(reloaded.listJobs()[0].name).toBe("reload-me");
    reloaded.stop();
  });

  it("start/stop controls the scheduler", () => {
    expect(engine.isRunning()).toBe(false);
    engine.start();
    expect(engine.isRunning()).toBe(true);
    engine.start(); // idempotent
    expect(engine.isRunning()).toBe(true);
    engine.stop();
    expect(engine.isRunning()).toBe(false);
  });
});
