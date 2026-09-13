import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import type { LanguageModel } from "ai";

const {
  generateTextMock,
  dynamicToolMock,
  jsonSchemaMock,
  stepCountIsMock,
} = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  dynamicToolMock: vi.fn((tool: unknown) => tool),
  jsonSchemaMock: vi.fn((schema: unknown) => schema),
  stepCountIsMock: vi.fn((_stepCount: number) => () => false),
}));

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
  dynamicTool: (...args: unknown[]) => dynamicToolMock(...args),
  jsonSchema: (...args: unknown[]) => jsonSchemaMock(...args),
  stepCountIs: (...args: unknown[]) => stepCountIsMock(...args),
}));

import { AgentOrchestrator } from "../src/agents/orchestrator.js";

const fakeModel = {} as LanguageModel;

function makeOrchestrator(): AgentOrchestrator {
  const orchestrator = new AgentOrchestrator();
  orchestrator.setModel(fakeModel);
  orchestrator.registerAgent({
    name: "researcher",
    description: "searches the web and gathers information",
    systemPrompt: "You are a researcher.",
  });
  orchestrator.registerAgent({
    name: "coder",
    description: "writes and fixes code",
    systemPrompt: "You are a coder.",
  });
  return orchestrator;
}

beforeEach(() => {
  generateTextMock.mockReset();
  dynamicToolMock.mockReset();
  jsonSchemaMock.mockReset();
  stepCountIsMock.mockReset();
  stepCountIsMock.mockImplementation((_stepCount: number) => () => false);
  generateTextMock.mockResolvedValue({
    text: "final answer",
    steps: [{ toolCalls: [] }],
  });
});

describe("routeTask", () => {
  it("routes a task to the best matching agent by description", () => {
    const orchestrator = makeOrchestrator();
    const result = orchestrator.routeTask("write a function to sort an array");
    expect(result.agentName).toBe("coder");
    expect(result.score).toBeGreaterThan(0);
  });

  it("routes to a researcher for an information-gathering task", () => {
    const orchestrator = makeOrchestrator();
    const result = orchestrator.routeTask("search the web for the latest news");
    expect(result.agentName).toBe("researcher");
  });

  it("respects an explicit agent list", () => {
    const orchestrator = makeOrchestrator();
    const result = orchestrator.routeTask("write code", [
      { name: "researcher", description: "searches the web", systemPrompt: "r" },
    ]);
    expect(result.agentName).toBe("researcher");
  });

  it("throws when no agents are available", () => {
    const orchestrator = new AgentOrchestrator();
    expect(() => orchestrator.routeTask("anything")).toThrow(
      "No agents available"
    );
  });
});

describe("runAgent / runParallel", () => {
  it("runs a single agent and returns a result", async () => {
    const orchestrator = makeOrchestrator();
    const result = await orchestrator.runAgent("coder", "write code");
    expect(result.text).toBe("final answer");
    expect(result.iterations).toBe(1);
    expect(result.toolCalls).toBe(0);
  });

  it("runs tasks in parallel", async () => {
    const orchestrator = makeOrchestrator();
    const results = await orchestrator.runParallel([
      { agentName: "coder", prompt: "write code" },
      { agentName: "researcher", prompt: "find info" },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0].text).toBe("final answer");
    expect(results[1].text).toBe("final answer");
  });

  it("throws for an unknown agent", async () => {
    const orchestrator = makeOrchestrator();
    await expect(orchestrator.runAgent("ghost", "hi")).rejects.toThrow(
      'Agent "ghost" not registered'
    );
  });
});

describe("native tool calling", () => {
  it("completes a multi-step tool task via native tool calls", async () => {
    const orchestrator = makeOrchestrator();
    orchestrator.registerTool({
      name: "search",
      description: "search the web",
      execute: vi.fn().mockResolvedValue({ success: true, output: "results" }),
    });

    generateTextMock.mockResolvedValue({
      text: "final answer",
      steps: [
        { toolCalls: [{ toolName: "search", input: { query: "x" } }] },
        { toolCalls: [{ toolName: "search", input: { query: "y" } }] },
      ],
    });

    const onToolCall = vi.fn();
    const result = await orchestrator.runAgent(
      "coder",
      "do research",
      onToolCall
    );

    expect(result.text).toBe("final answer");
    expect(result.iterations).toBe(2);
    expect(result.toolCalls).toBe(2);
    expect(onToolCall).toHaveBeenCalledTimes(2);
    expect(onToolCall).toHaveBeenCalledWith("search", { query: "x" });
    expect(onToolCall).toHaveBeenCalledWith("search", { query: "y" });
  });

  it("builds a dynamic tool for each registered tool", async () => {
    const orchestrator = makeOrchestrator();
    orchestrator.registerTool({
      name: "search",
      description: "search the web",
      execute: vi.fn().mockResolvedValue({ success: true, output: "results" }),
    });

    await orchestrator.runAgent("coder", "write code");

    expect(dynamicToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "search the web",
        inputSchema: expect.anything(),
        execute: expect.any(Function),
      })
    );
  });

  it("caps iterations at maxIterations and returns a max-steps message when no final text", async () => {
    const orchestrator = makeOrchestrator();
    generateTextMock.mockResolvedValue({
      text: "",
      steps: Array.from({ length: 5 }, () => ({ toolCalls: [] })),
    });

    const result = await orchestrator.runAgent("coder", "write code");

    expect(result.text).toBe("Max iterations reached without final answer.");
    expect(result.iterations).toBe(5);
    expect(result.toolCalls).toBe(0);
    expect(stepCountIsMock).toHaveBeenCalledWith(5);
  });

  it("uses the agent's maxIterations for the stop condition", async () => {
    const orchestrator = makeOrchestrator();
    orchestrator.registerAgent({
      name: "bounded",
      description: "bounded agent",
      systemPrompt: "You are bounded.",
      maxIterations: 3,
    });

    await orchestrator.runAgent("bounded", "do work");

    expect(stepCountIsMock).toHaveBeenCalledWith(3);
  });
});

describe("task queue", () => {
  it("tracks task status through completion", async () => {
    const orchestrator = makeOrchestrator();
    const result = await orchestrator.runAgent("coder", "write code");
    const tasks = orchestrator.listTasks();
    expect(tasks).toHaveLength(1);
    const task = tasks[0];
    expect(task.status).toBe("completed");
    expect(task.result).toBe("final answer");
    expect(orchestrator.getTask(task.id)).toBe(task);
    expect(orchestrator.getTaskStatus(task.id)).toBe("completed");
    expect(result.text).toBe("final answer");
  });

  it("marks a task as failed when the model throws", async () => {
    generateTextMock.mockRejectedValue(new Error("model exploded"));
    const orchestrator = makeOrchestrator();
    await expect(orchestrator.runAgent("coder", "write code")).rejects.toThrow(
      "model exploded"
    );
    const task = orchestrator.listTasks()[0];
    expect(task.status).toBe("failed");
    expect(task.error).toBe("model exploded");
  });

  it("records status 'failed' with the error on the task when execution fails", async () => {
    generateTextMock.mockRejectedValue(new Error("tool exploded"));
    const orchestrator = makeOrchestrator();
    await expect(orchestrator.runAgent("coder", "write code")).rejects.toThrow(
      "tool exploded"
    );
    const task = orchestrator.listTasks()[0];
    expect(orchestrator.getTaskStatus(task.id)).toBe("failed");
    expect(task.error).toBe("tool exploded");
  });
});

describe("delegate", () => {
  it("delegates a subtask to another agent with isolated context", async () => {
    const orchestrator = makeOrchestrator();
    const result = await orchestrator.delegate(
      "coder",
      "researcher",
      "find the docs"
    );
    expect(result.text).toBe("final answer");

    const tasks = orchestrator.listTasks();
    expect(tasks).toHaveLength(1);
    const task = tasks[0];
    expect(task.agentName).toBe("researcher");
    expect(task.parentId).toBe("coder");
    expect(task.status).toBe("completed");
  });

  it("throws when the delegating agent is unknown", async () => {
    const orchestrator = makeOrchestrator();
    await expect(
      orchestrator.delegate("ghost", "researcher", "find info")
    ).rejects.toThrow('Agent "ghost" not registered');
  });

  it("throws when the target agent is unknown", async () => {
    const orchestrator = makeOrchestrator();
    await expect(
      orchestrator.delegate("coder", "ghost", "find info")
    ).rejects.toThrow('Agent "ghost" not registered');
  });
});

describe("guard: no legacy regex tool parsing", () => {
  it("does not contain the legacy ```tool parsing pattern in the orchestrator source", () => {
    const source = readFileSync(
      new URL("../src/agents/orchestrator.ts", import.meta.url),
      "utf-8"
    );
    expect(source).not.toMatch(/```tool/);
  });
});
