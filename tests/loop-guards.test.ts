import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ToolFailureTracker, normalizeSignature } from "../src/agent/loop-guards.js";
import { Repl } from "../src/repl.js";
import { ContextEngine } from "../src/context/engine.js";
import { PlanStore } from "../src/agent/plan.js";
import type { LanguageModel } from "ai";

describe("normalizeSignature", () => {
  it("collapses whitespace, truncates to 200 chars, and masks digits", () => {
    const sig = normalizeSignature("  error   code 12345\n  line 678  ");
    expect(sig).toBe("error code ##### line ###");
  });
});

describe("ToolFailureTracker", () => {
  let tracker: ToolFailureTracker;

  beforeEach(() => {
    tracker = new ToolFailureTracker();
  });

  it("is not stalled on a single failure", () => {
    tracker.setCurrentStep("step-1");
    tracker.recordFailure("bash", "npm test", "sig-a");
    expect(tracker.isStalled("bash", "npm test", "sig-a")).toBe(false);
  });

  it("is stalled when the same command fails twice consecutively with the same signature", () => {
    tracker.setCurrentStep("step-1");
    tracker.recordFailure("bash", "npm test", "sig-a");
    tracker.recordFailure("bash", "npm test", "sig-a");
    expect(tracker.isStalled("bash", "npm test", "sig-a")).toBe(true);
  });

  it("is not stalled when the signatures differ", () => {
    tracker.setCurrentStep("step-1");
    tracker.recordFailure("bash", "npm test", "sig-a");
    tracker.recordFailure("bash", "npm test", "sig-b");
    expect(tracker.isStalled("bash", "npm test", "sig-b")).toBe(false);
  });

  it("is not stalled across different targets", () => {
    tracker.setCurrentStep("step-1");
    tracker.recordFailure("bash", "cmd-a", "sig-a");
    tracker.recordFailure("bash", "cmd-b", "sig-a");
    expect(tracker.isStalled("bash", "cmd-a", "sig-a")).toBe(false);
    expect(tracker.isStalled("bash", "cmd-b", "sig-a")).toBe(false);
  });

  it("tracks attempts per step", () => {
    tracker.setCurrentStep("step-1");
    tracker.recordFailure("bash", "a", "s1");
    tracker.recordFailure("bash", "a", "s1");
    expect(tracker.attemptsFor("step-1")).toBe(2);
    expect(tracker.attemptsFor("step-2")).toBe(0);
  });

  it("returns 0 attempts when no step is set", () => {
    expect(tracker.attemptsFor()).toBe(0);
  });
});

describe("REPL loop guards (Phase 3.4)", () => {
  let repl: Repl;
  let mockModel: LanguageModel;
  let mockContextEngine: ContextEngine;

  const makeRepl = (config?: Record<string, unknown>) => {
    mockModel = {
      provider: "test",
      modelId: "test-model",
      specificationVersion: "v1",
      defaultObjectGenerationMode: "auto",
      supportsStructuredOutputs: true,
      doGenerate: vi.fn().mockResolvedValue({ text: "ok" }),
      doStream: vi.fn().mockImplementation(async function* () {
        yield "ok";
      }),
    } as unknown as LanguageModel;
    mockContextEngine = new ContextEngine(process.cwd());
    vi.spyOn(mockContextEngine, "getContextForPrompt").mockResolvedValue("test context");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    repl = new Repl({
      model: mockModel,
      contextEngine: mockContextEngine,
      config: {
        defaultProvider: "openai",
        defaultModel: "gpt-4o",
        ...config,
      } as never,
    });
  };

  const getTools = () =>
    (repl as unknown as {
      getTools: () => Record<string, { execute: (args: Record<string, unknown>) => Promise<string> }>;
    }).getTools();

  const getPlanStore = () => (repl as unknown as { planStore: PlanStore }).planStore;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks the in-progress step on a stall (same command + same error twice)", async () => {
    makeRepl();
    const tools = getTools();
    const store = getPlanStore();

    await tools["plan_update"].execute({ goal: "Goal", steps: ["A", "B"] });
    const plan = store.get()!;
    await tools["plan_advance"].execute({ stepId: plan.steps[0].id });

    // Two consecutive identical failures on the in-progress step.
    await tools["readFile"].execute({ path: "__nonexistent__" });
    await tools["readFile"].execute({ path: "__nonexistent__" });

    const after = store.get()!;
    expect(after.steps[0].status).toBe("blocked");
    expect(after.steps[0].lastError).toContain("Stalled");
  });

  it("never allows a third identical execution to pass silently after a stall", async () => {
    makeRepl();
    const tools = getTools();
    const store = getPlanStore();

    await tools["plan_update"].execute({ goal: "Goal", steps: ["A"] });
    const plan = store.get()!;
    await tools["plan_advance"].execute({ stepId: plan.steps[0].id });

    await tools["readFile"].execute({ path: "__nonexistent__" });
    await tools["readFile"].execute({ path: "__nonexistent__" });
    // Third attempt: step is already blocked, so no further in-progress step exists.
    const out = await tools["readFile"].execute({ path: "__nonexistent__" });
    expect(out).toContain("Error");
    const after = store.get()!;
    expect(after.steps[0].status).toBe("blocked");
  });

  it("marks the step failed when the retry budget is exceeded", async () => {
    makeRepl();
    const tools = getTools();
    const store = getPlanStore();

    await tools["plan_update"].execute({ goal: "Goal", steps: ["A"] });
    const plan = store.get()!;
    await tools["plan_advance"].execute({ stepId: plan.steps[0].id });

    // Three failures (default budget 3) with different signatures -> failed, not stalled.
    await tools["readFile"].execute({ path: "__nonexistent_alpha__" });
    await tools["readFile"].execute({ path: "__nonexistent_beta__" });
    await tools["readFile"].execute({ path: "__nonexistent_gamma__" });

    const after = store.get()!;
    expect(after.steps[0].status).toBe("failed");
    expect(after.steps[0].lastError).toContain("retry budget");
  });

  it("respects a custom retry budget", async () => {
    makeRepl({ autonomy: { retryBudget: 1 } });
    const tools = getTools();
    const store = getPlanStore();

    await tools["plan_update"].execute({ goal: "Goal", steps: ["A"] });
    const plan = store.get()!;
    await tools["plan_advance"].execute({ stepId: plan.steps[0].id });

    await tools["readFile"].execute({ path: "__nonexistent_alpha__" });

    const after = store.get()!;
    expect(after.steps[0].status).toBe("failed");
  });

  it("does not fail the step before the budget is reached", async () => {
    makeRepl();
    const tools = getTools();
    const store = getPlanStore();

    await tools["plan_update"].execute({ goal: "Goal", steps: ["A"] });
    const plan = store.get()!;
    await tools["plan_advance"].execute({ stepId: plan.steps[0].id });

    await tools["readFile"].execute({ path: "__nonexistent_alpha__" });
    await tools["readFile"].execute({ path: "__nonexistent_beta__" });

    const after = store.get()!;
    expect(after.steps[0].status).toBe("in-progress");
  });
});
