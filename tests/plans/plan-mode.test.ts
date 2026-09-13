import { describe, it, expect, vi, beforeEach } from "vitest";
import { Repl } from "../../src/repl.js";
import { ContextEngine } from "../../src/context/engine.js";
import type { LanguageModel } from "ai";

// Mock LanguageModel
const createMockModel = (): LanguageModel => ({
  provider: "test",
  modelId: "test-model",
  specificationVersion: "v1",
  defaultObjectGenerationMode: "auto",
  supportsStructuredOutputs: true,
  doGenerate: vi.fn(),
  doStream: vi.fn(),
});

describe("Plan Mode", () => {
  let repl: Repl;
  let mockModel: LanguageModel;
  let mockContextEngine: ContextEngine;

  beforeEach(() => {
    mockModel = createMockModel();
    mockContextEngine = new ContextEngine(process.cwd());
    vi.spyOn(mockContextEngine, "indexCodebase").mockResolvedValue(undefined);
    vi.spyOn(mockContextEngine, "getFileCount").mockReturnValue(10);
    vi.spyOn(mockContextEngine, "getContextForPrompt").mockResolvedValue("test context");
    vi.spyOn(mockContextEngine, "getFileTree").mockReturnValue("test tree");
  });

  it("should start with plan mode disabled by default", () => {
    repl = new Repl({
      model: mockModel,
      contextEngine: mockContextEngine,
    });
    expect(repl.isPlanMode()).toBe(false);
  });

  it("should enable plan mode when configured", () => {
    repl = new Repl({
      model: mockModel,
      contextEngine: mockContextEngine,
      config: { planMode: { enabled: true } },
    });
    expect(repl.isPlanMode()).toBe(true);
  });

  it("should toggle plan mode off when /plan off is called", () => {
    repl = new Repl({
      model: mockModel,
      contextEngine: mockContextEngine,
      config: { planMode: { enabled: true } },
    });
    expect(repl.isPlanMode()).toBe(true);
    
    // Access private method via type assertion for testing
    (repl as any).handlePlanCommand("off");
    expect(repl.isPlanMode()).toBe(false);
  });

  it("should toggle plan mode on when /plan is called", () => {
    repl = new Repl({
      model: mockModel,
      contextEngine: mockContextEngine,
    });
    expect(repl.isPlanMode()).toBe(false);
    
    (repl as any).handlePlanCommand("");
    expect(repl.isPlanMode()).toBe(true);
  });

  it("should block agent commands when plan mode is active", async () => {
    repl = new Repl({
      model: mockModel,
      contextEngine: mockContextEngine,
      config: { planMode: { enabled: true } },
    });
    
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (repl as any).handleAgentCommand("test-agent test prompt");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Plan mode is ON — agents are blocked")
    );
    consoleSpy.mockRestore();
  });
});