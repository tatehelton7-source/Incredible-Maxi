import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlanStore, renderPlanBlock, type Plan, type PlanStep } from "../src/agent/plan.js";
import { Repl } from "../src/repl.js";
import { ContextEngine } from "../src/context/engine.js";
import type { LanguageModel } from "ai";

const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }));
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: streamTextMock };
});

describe("PlanStore", () => {
  let store: PlanStore;

  beforeEach(() => {
    store = new PlanStore();
  });

  it("creates a plan with pending steps and attempts 0", () => {
    const plan = store.create("Build a feature", ["Step one", "Step two"]);
    expect(plan.goal).toBe("Build a feature");
    expect(plan.revision).toBe(1);
    expect(plan.steps).toHaveLength(2);
    for (const step of plan.steps) {
      expect(step.status).toBe("pending");
      expect(step.attempts).toBe(0);
      expect(step.id).toBeTruthy();
    }
  });

  it("advances a pending step to in-progress", () => {
    const plan = store.create("Goal", ["A", "B"]);
    const result = store.advance(plan.steps[0].id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.step.status).toBe("in-progress");
  });

  it("enforces the single in-progress invariant", () => {
    const plan = store.create("Goal", ["A", "B"]);
    store.advance(plan.steps[0].id);
    const second = store.advance(plan.steps[1].id);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain("in-progress");
  });

  it("advances an in-progress step to verified when it has no gate", () => {
    const plan = store.create("Goal", ["A"]);
    store.advance(plan.steps[0].id);
    const result = store.advance(plan.steps[0].id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.step.status).toBe("verified");
  });

  it("rejects verifying a gated step with an explanatory error", () => {
    const plan = store.create("Goal", ["A"]);
    const gated: PlanStep = { ...plan.steps[0], gate: "npm test" };
    store.update(plan.goal, [gated]);
    store.advance(gated.id);
    const result = store.advance(gated.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("gate");
  });

  it("blocks and fails a step with a reason", () => {
    const plan = store.create("Goal", ["A"]);
    const blocked = store.block(plan.steps[0].id, "stalled");
    expect(blocked.ok).toBe(true);
    if (blocked.ok) {
      expect(blocked.step.status).toBe("blocked");
      expect(blocked.step.lastError).toBe("stalled");
    }
    const failed = store.fail(plan.steps[0].id, "boom");
    expect(failed.ok).toBe(true);
    if (failed.ok) {
      expect(failed.step.status).toBe("failed");
      expect(failed.step.lastError).toBe("boom");
    }
  });

  it("update replaces the step list and increments revision", () => {
    store.create("Goal", ["A"]);
    const updated = store.update("New goal", [
      { id: "x", description: "X", status: "pending", attempts: 0 },
    ]);
    expect(updated).toBeDefined();
    expect(updated!.goal).toBe("New goal");
    expect(updated!.revision).toBe(2);
    expect(updated!.steps).toHaveLength(1);
  });

  it("rewrite supersedes the old plan and keeps it in history", () => {
    const first = store.create("Old goal", ["A"]);
    const second = store.rewrite("New goal", [
      { id: "y", description: "Y", status: "pending", attempts: 0 },
    ]);
    expect(store.get()?.goal).toBe("New goal");
    expect(second.supersededBy).toBeUndefined();
    const history = store.historyPlans();
    expect(history).toHaveLength(1);
    expect(history[0].goal).toBe("Old goal");
    expect(history[0].supersededBy).toBeTruthy();
    expect(first).not.toBe(history[0]);
  });
});

describe("renderPlanBlock", () => {
  it("renders under the 15-line cap with ASCII glyphs", () => {
    const plan: Plan = {
      goal: "Ship the feature",
      revision: 3,
      steps: [
        { id: "s1", description: "Research", status: "verified", attempts: 1 },
        { id: "s2", description: "Implement", status: "in-progress", attempts: 2 },
        { id: "s3", description: "Test", status: "pending", attempts: 0 },
        { id: "s4", description: "Blocked thing", status: "blocked", attempts: 3, lastError: "x" },
        { id: "s5", description: "Failed thing", status: "failed", attempts: 1 },
      ],
    };
    const block = renderPlanBlock(plan);
    const lines = block.split("\n");
    expect(lines.length).toBeLessThanOrEqual(15);
    expect(block).toContain("rev 3");
    expect(block).toContain("[x]");
    expect(block).toContain("[>]");
    expect(block).toContain("[ ]");
    expect(block).toContain("[!]");
    expect(block).toContain("[X]");
    expect(block).toContain("->");
  });
});

describe("REPL plan tools", () => {
  let repl: Repl;
  let mockModel: LanguageModel;
  let mockContextEngine: ContextEngine;

  beforeEach(() => {
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
    repl = new Repl({ model: mockModel, contextEngine: mockContextEngine });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes plan_update and plan_advance through the tool map", () => {
    const tools = (repl as unknown as {
      getTools: () => Record<string, { execute: (args: Record<string, unknown>) => Promise<string> }>;
    }).getTools();
    expect(tools["plan_update"]).toBeDefined();
    expect(tools["plan_advance"]).toBeDefined();
  });

  it("plan_update creates a plan and plan_advance advances a step", async () => {
    const tools = (repl as unknown as {
      getTools: () => Record<string, { execute: (args: Record<string, unknown>) => Promise<string> }>;
    }).getTools();
    const createOut = await tools["plan_update"].execute({ goal: "Goal", steps: ["A", "B"] });
    expect(createOut).toContain("Plan created");

    const planStore = (repl as unknown as { planStore: PlanStore }).planStore;
    const plan = planStore.get();
    expect(plan).toBeDefined();
    expect(plan!.steps).toHaveLength(2);

    const advanceOut = await tools["plan_advance"].execute({ stepId: plan!.steps[0].id });
    expect(advanceOut).toContain("in-progress");
  });
});

describe("Phase 3.0 prompt layering", () => {
  it("freezes the system prompt byte-identical across turns and keeps reminders out of it", async () => {
    const systems: string[] = [];
    streamTextMock.mockImplementation((opts: { system?: string }) => {
      systems.push(opts.system ?? "");
      return {
        textStream: (async function* () {
          yield "hello";
        })(),
        text: Promise.resolve("hello"),
      };
    });

    const model = {
      provider: "test",
      modelId: "test-model",
      specificationVersion: "v1",
      defaultObjectGenerationMode: "auto",
      supportsStructuredOutputs: true,
      doGenerate: vi.fn(),
      doStream: vi.fn(),
    } as unknown as LanguageModel;

    const contextEngine = new ContextEngine(process.cwd());
    vi.spyOn(contextEngine, "getContextForPrompt").mockResolvedValue("project snapshot");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const repl = new Repl({ model, contextEngine });
    const replWithChat = repl as unknown as { handleChat: (i: string) => Promise<void> };

    await replWithChat.handleChat("first message");
    await replWithChat.handleChat("second message");

    expect(systems).toHaveLength(2);
    expect(systems[0]).toBe(systems[1]);
    expect(systems[0]).toContain("project snapshot");
    expect(systems[0]).not.toContain("<system-reminder>");
  });
});
