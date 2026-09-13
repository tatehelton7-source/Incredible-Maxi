import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Repl } from "../src/repl.js";
import { ContextEngine } from "../src/context/engine.js";
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

describe("Integration Tests", () => {
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
      doGenerate: vi.fn().mockResolvedValue({ text: "test response" }),
      doStream: vi.fn().mockImplementation(async function* () {
        yield "test response";
      }),
    } as any;

    mockContextEngine = new ContextEngine(process.cwd());
    vi.spyOn(mockContextEngine, "indexCodebase").mockResolvedValue(undefined);
    vi.spyOn(mockContextEngine, "getFileCount").mockReturnValue(10);
    vi.spyOn(mockContextEngine, "getContextForPrompt").mockResolvedValue("test context");
    vi.spyOn(mockContextEngine, "getFileTree").mockReturnValue("test tree");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should initialize REPL with plan mode disabled by default", () => {
    repl = new Repl({
      model: mockModel,
      contextEngine: mockContextEngine,
    });
    expect(repl.isPlanMode()).toBe(false);
    expect(repl.isRunning()).toBe(false);
  });

  it("should initialize REPL with plan mode enabled from config", () => {
    repl = new Repl({
      model: mockModel,
      contextEngine: mockContextEngine,
      config: { planMode: { enabled: true } },
    });
    expect(repl.isPlanMode()).toBe(true);
  });

  it("should toggle plan mode on and off", () => {
    repl = new Repl({
      model: mockModel,
      contextEngine: mockContextEngine,
    });
    expect(repl.isPlanMode()).toBe(false);
    
    (repl as any).handlePlanCommand("");
    expect(repl.isPlanMode()).toBe(true);
    
    (repl as any).handlePlanCommand("off");
    expect(repl.isPlanMode()).toBe(false);
  });

  it("should have spinner initialized", () => {
    repl = new Repl({
      model: mockModel,
      contextEngine: mockContextEngine,
    });
    // Spinner should be initialized
    expect((repl as any).spinner).toBeDefined();
    // In test environment, spinner may be disabled due to no TTY
    expect(typeof (repl as any).spinner.isEnabled).toBe("function");
  });

  it("should have getTools method returning all 21 built-in tools", () => {
    repl = new Repl({
      model: mockModel,
      contextEngine: mockContextEngine,
      config: { defaultProvider: "openai", defaultModel: "gpt-4o" },
    });
    const tools = (repl as any).getTools();
    expect(Object.keys(tools)).toHaveLength(21);
    expect(tools.readFile).toBeDefined();
    expect(tools.writeFile).toBeDefined();
    expect(tools.editFile).toBeDefined();
    expect(tools.bash).toBeDefined();
    expect(tools.listDirectory).toBeDefined();
    expect(tools.glob).toBeDefined();
    expect(tools.grep).toBeDefined();
    expect(tools.gitStatus).toBeDefined();
    expect(tools.gitDiff).toBeDefined();
    expect(tools.gitLog).toBeDefined();
    expect(tools.gitAdd).toBeDefined();
    expect(tools.gitCommit).toBeDefined();
    expect(tools.gitBranch).toBeDefined();
    expect(tools.gitCheckout).toBeDefined();
    expect(tools.webSearch).toBeDefined();
    expect(tools.fetchUrl).toBeDefined();
    expect(tools.detectLanguage).toBeDefined();
    expect(tools.runToolchain).toBeDefined();
    expect(tools.plan_update).toBeDefined();
    expect(tools.plan_advance).toBeDefined();
    expect(tools.architecture_update).toBeDefined();
  });

  

  it("should load skills from directory", async () => {
    const { loadSkills } = await import("../../src/skills/loader.js");
    const skills = loadSkills({ skills: { directories: [] } } as any);
    expect(Array.isArray(skills)).toBe(true);
  });

  it("should parse CLAUDE.md config", async () => {
    const { loadConfigWithClaudeMd } = await import("../../src/configLoader.js");
    const config = loadConfigWithClaudeMd();
    expect(config).toBeDefined();
    expect(config.defaultProvider).toBeDefined();
    expect(config.defaultModel).toBeDefined();
  });

  it("should handle /orchestrate with a mock orchestrator", async () => {
    const mockOrchestrator = {
      routeTask: vi.fn().mockReturnValue({ agentName: "builder", score: 3 }),
      runAgent: vi.fn().mockResolvedValue({ text: "orchestrated result", iterations: 1, toolCalls: 0 }),
    };
    repl = new Repl({
      model: mockModel,
      contextEngine: mockContextEngine,
      orchestrator: mockOrchestrator as any,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (repl as any).handleOrchestrateCommand("build the thing");
    expect(mockOrchestrator.routeTask).toHaveBeenCalledWith("build the thing");
    expect(mockOrchestrator.runAgent).toHaveBeenCalledWith("builder", "build the thing", expect.any(Function));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("orchestrated result"));
    logSpy.mockRestore();
  });

  it("should handle /orchestrate without an orchestrator gracefully", async () => {
    repl = new Repl({ model: mockModel, contextEngine: mockContextEngine });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (repl as any).handleOrchestrateCommand("build the thing");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("not configured"));
    logSpy.mockRestore();
  });

  it("should handle /automation list, add, and remove", () => {
    const mockEngine = {
      registerJob: vi.fn().mockReturnValue("job-1"),
      removeJob: vi.fn().mockReturnValue(true),
      listJobs: vi.fn().mockReturnValue([
        {
          id: "job-1",
          name: "nightly",
          trigger: { type: "cron", schedule: "0 2 * * *" },
          agentName: "builder",
          prompt: "run tests",
          enabled: true,
        },
      ]),
    };
    repl = new Repl({
      model: mockModel,
      contextEngine: mockContextEngine,
      automationEngine: mockEngine as any,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    (repl as any).handleAutomationCommand("");
    expect(mockEngine.listJobs).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("nightly"));
    (repl as any).handleAutomationCommand("add nightly 0 2 * * * builder run tests");
    expect(mockEngine.registerJob).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "nightly",
        trigger: { type: "cron", schedule: "0 2 * * *" },
        agentName: "builder",
        prompt: "run tests",
      })
    );
    (repl as any).handleAutomationCommand("remove job-1");
    expect(mockEngine.removeJob).toHaveBeenCalledWith("job-1");
    logSpy.mockRestore();
  });

  it("should handle /automation without an engine gracefully", () => {
    repl = new Repl({ model: mockModel, contextEngine: mockContextEngine });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    (repl as any).handleAutomationCommand("");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("not configured"));
    logSpy.mockRestore();
  });

  it("should handle /agents listing agents and tasks", () => {
    const mockOrchestrator = {
      listAgents: vi.fn().mockReturnValue([
        { name: "builder", description: "Builds things" },
        { name: "reviewer", description: "Reviews things" },
      ]),
      listTasks: vi.fn().mockReturnValue([
        { id: "task-1", prompt: "do something", agentName: "builder", status: "completed" },
      ]),
    };
    repl = new Repl({
      model: mockModel,
      contextEngine: mockContextEngine,
      orchestrator: mockOrchestrator as any,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    (repl as any).handleAgentsCommand();
    expect(mockOrchestrator.listAgents).toHaveBeenCalled();
    expect(mockOrchestrator.listTasks).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("builder"));
    logSpy.mockRestore();
  });

  it("should handle /acp connect and disconnect", async () => {
    const mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      toAgentConfig: vi.fn().mockReturnValue({ name: "acp-agent", description: "External", systemPrompt: "marker" }),
    };
    const mockOrchestrator = {
      registerAgent: vi.fn(),
    };
    repl = new Repl({
      model: mockModel,
      contextEngine: mockContextEngine,
      acpClient: mockClient as any,
      orchestrator: mockOrchestrator as any,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (repl as any).handleAcpCommand("connect acp-agent");
    expect(mockClient.connect).toHaveBeenCalled();
    expect(mockOrchestrator.registerAgent).toHaveBeenCalled();
    await (repl as any).handleAcpCommand("disconnect");
    expect(mockClient.close).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("should handle /acp without configuration gracefully", async () => {
    repl = new Repl({ model: mockModel, contextEngine: mockContextEngine });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (repl as any).handleAcpCommand("");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("not configured"));
    logSpy.mockRestore();
  });
});