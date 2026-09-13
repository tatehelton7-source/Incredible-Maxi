import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanStore, type PlanStep } from "../src/agent/plan.js";
import { detectToolchainGates } from "../src/agent/gates.js";
import { Repl } from "../src/repl.js";
import { ContextEngine } from "../src/context/engine.js";
import type { LanguageModel } from "ai";

const createMockModel = (): LanguageModel =>
  ({
    provider: "test",
    modelId: "test-model",
    specificationVersion: "v2",
    supportedUrls: {},
    doGenerate: async () => ({
      content: [],
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      warnings: [],
    }),
    doStream: async () => {
      throw new Error("not used");
    },
  }) as unknown as LanguageModel;

describe("PlanStore.advanceWithGate", () => {
  let store: PlanStore;

  beforeEach(() => {
    store = new PlanStore();
  });

  const gatedStep = (gate: string): PlanStep => {
    const plan = store.create("Goal", ["A"]);
    const gated: PlanStep = { ...plan.steps[0], gate };
    store.update(plan.goal, [gated]);
    store.advance(gated.id); // pending → in-progress
    return gated;
  };

  it("verifies a gated step when the gate exits 0 and writes snapshotId", async () => {
    const step = gatedStep("npm test");
    const runGate = vi.fn().mockResolvedValue({ exitCode: 0, output: "ok", snapshotId: "snap-123" });
    const result = await store.advanceWithGate(step.id, runGate);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.step.status).toBe("verified");
      expect(result.step.snapshotId).toBe("snap-123");
    }
    expect(runGate).toHaveBeenCalledWith("npm test");
  });

  it("keeps a gated step in-progress and sets lastError on nonzero exit", async () => {
    const step = gatedStep("npm test");
    const runGate = vi.fn().mockResolvedValue({ exitCode: 1, output: "tests failed" });
    const result = await store.advanceWithGate(step.id, runGate);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.step.status).toBe("in-progress");
      expect(result.step.lastError).toContain("tests failed");
      expect(result.step.snapshotId).toBeUndefined();
    }
  });

  it("does not write snapshotId when the gate passes without one", async () => {
    const step = gatedStep("npm test");
    const runGate = vi.fn().mockResolvedValue({ exitCode: 0, output: "ok" });
    const result = await store.advanceWithGate(step.id, runGate);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.step.status).toBe("verified");
      expect(result.step.snapshotId).toBeUndefined();
    }
  });

  it("advance rejects a gated step without running the gate", () => {
    const step = gatedStep("npm test");
    const result = store.advance(step.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("gate");
  });

  it("advanceWithGate transitions a pending gated step to in-progress without running the gate", async () => {
    const plan = store.create("Goal", ["A"]);
    const gated: PlanStep = { ...plan.steps[0], gate: "npm test" };
    store.update(plan.goal, [gated]);
    const runGate = vi.fn();
    const result = await store.advanceWithGate(gated.id, runGate);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.step.status).toBe("in-progress");
    expect(runGate).not.toHaveBeenCalled();
  });
});

describe("detectToolchainGates", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "maxi-gates-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds npm test/lint scripts in a package.json fixture", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run", lint: "eslint src/" } })
    );
    const gates = detectToolchainGates(dir);
    expect(gates).toContain("npm run test");
    expect(gates).toContain("npm run lint");
  });

  it("returns empty for an empty directory", () => {
    expect(detectToolchainGates(dir)).toEqual([]);
  });

  it("detects pytest via pyproject.toml", () => {
    writeFileSync(join(dir, "pyproject.toml"), "[tool.pytest.ini_options]\n");
    expect(detectToolchainGates(dir)).toContain("python -m pytest");
  });

  it("detects cargo test via Cargo.toml", () => {
    writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = \"x\"\n");
    expect(detectToolchainGates(dir)).toContain("cargo test");
  });

  it("detects go test via go.mod", () => {
    writeFileSync(join(dir, "go.mod"), "module example.com/x\n");
    expect(detectToolchainGates(dir)).toContain("go test ./...");
  });

  it("detects make test via a Makefile test target", () => {
    writeFileSync(join(dir, "Makefile"), "test:\n\tnpm test\n");
    expect(detectToolchainGates(dir)).toContain("make test");
  });
});

describe("no-toolchain fallback overlay", () => {
  let repl: Repl;
  let mockContextEngine: ContextEngine;

  beforeEach(() => {
    mockContextEngine = new ContextEngine(process.cwd());
    vi.spyOn(mockContextEngine, "getContextForPrompt").mockResolvedValue("test context");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("with no toolchain + ungated plan, writeFile asks while readFile stays allow", async () => {
    repl = new Repl({
      model: createMockModel(),
      contextEngine: mockContextEngine,
      config: {
        defaultProvider: "test",
        defaultModel: "test-model",
        approval: { mode: "plan-then-ask" },
      },
      toolchainDetected: false,
    });
    const tools = (repl as unknown as {
      getTools: () => Record<string, { execute: (a: Record<string, unknown>) => Promise<string> }>;
    }).getTools();

    // Create an ungated plan.
    await tools["plan_update"].execute({ goal: "Goal", steps: ["A"] });

    // Deny any approval prompt so the write never executes.
    vi.spyOn(repl as unknown as { askQuestion: (q: string) => Promise<string> }, "askQuestion").mockResolvedValue("n");

    const writeOut = await tools.writeFile.execute({ path: "src/new.ts", content: "x" });
    expect(writeOut).toContain("Blocked by policy");

    const readOut = await tools.readFile.execute({ path: "__nonexistent__" });
    expect(readOut).not.toContain("Blocked by policy");
  });

  it("with toolchain detected, writeFile is not forced to ask", async () => {
    repl = new Repl({
      model: createMockModel(),
      contextEngine: mockContextEngine,
      config: {
        defaultProvider: "test",
        defaultModel: "test-model",
        approval: { mode: "plan-then-ask" },
      },
      toolchainDetected: true,
    });
    const tools = (repl as unknown as {
      getTools: () => Record<string, { execute: (a: Record<string, unknown>) => Promise<string> }>;
    }).getTools();

    await tools["plan_update"].execute({ goal: "Goal", steps: ["A"] });

    const askSpy = vi
      .spyOn(repl as unknown as { askQuestion: (q: string) => Promise<string> }, "askQuestion")
      .mockResolvedValue("n");

    // writeFile should be allowed (no overlay), so it executes rather than asking.
    const tmpPath = join(tmpdir(), `maxi-overlay-${Date.now()}.ts`);
    const writeOut = await tools.writeFile.execute({ path: tmpPath, content: "x" });
    expect(askSpy).not.toHaveBeenCalled();
    expect(writeOut).not.toContain("Blocked by policy");
    rmSync(tmpPath, { force: true });
  });
});
