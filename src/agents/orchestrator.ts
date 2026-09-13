import {
  dynamicTool,
  generateText,
  jsonSchema,
  stepCountIs,
  type LanguageModel,
  type ToolSet,
} from "ai";
import type { Tool } from "../tools/types.js";

export interface AgentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  model?: string;
  tools?: string[];
  maxIterations?: number;
}

export interface AgentTask {
  id: string;
  prompt: string;
  agentName: string;
  status: "pending" | "running" | "completed" | "failed";
  result?: string;
  error?: string;
  parentId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentRunResult {
  text: string;
  iterations: number;
  toolCalls: number;
}

export interface RouteResult {
  agentName: string;
  score: number;
}

export class AgentOrchestrator {
  private agents: Map<string, AgentConfig> = new Map();
  private tools: Map<string, Tool> = new Map();
  private model: LanguageModel | null = null;
  private tasks: Map<string, AgentTask> = new Map();
  private taskCounter = 0;

  setModel(model: LanguageModel): void {
    this.model = model;
  }

  registerAgent(config: AgentConfig): void {
    this.agents.set(config.name, config);
  }

  getAgent(name: string): AgentConfig | undefined {
    return this.agents.get(name);
  }

  listAgents(): AgentConfig[] {
    return [...this.agents.values()];
  }

  registerTool(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  listTools(): Tool[] {
    return [...this.tools.values()];
  }

  getTask(id: string): AgentTask | undefined {
    return this.tasks.get(id);
  }

  getTaskStatus(id: string): AgentTask["status"] | undefined {
    return this.tasks.get(id)?.status;
  }

  listTasks(): AgentTask[] {
    return [...this.tasks.values()];
  }

  async runAgent(
    agentName: string,
    prompt: string,
    onToolCall?: (toolName: string, args: Record<string, unknown>) => void
  ): Promise<AgentRunResult> {
    const task = this.createTask(agentName, prompt);
    return this.executeTask(task.id, onToolCall);
  }

  async runParallel(
    tasks: { agentName: string; prompt: string }[]
  ): Promise<AgentRunResult[]> {
    return Promise.all(
      tasks.map((task) => this.runAgent(task.agentName, task.prompt))
    );
  }

  routeTask(prompt: string, agents?: AgentConfig[]): RouteResult {
    const candidates = agents && agents.length > 0 ? agents : this.listAgents();
    if (candidates.length === 0) {
      throw new Error("No agents available to route to");
    }
    const tokens = this.tokenize(prompt);
    let best: RouteResult | null = null;
    for (const agent of candidates) {
      const score = this.scoreAgent(agent, tokens);
      if (!best || score > best.score) {
        best = { agentName: agent.name, score };
      }
    }
    return best as RouteResult;
  }

  async delegate(
    fromAgent: string,
    toAgent: string,
    prompt: string
  ): Promise<AgentRunResult> {
    if (!this.agents.has(fromAgent)) {
      throw new Error(`Agent "${fromAgent}" not registered`);
    }
    if (!this.agents.has(toAgent)) {
      throw new Error(`Agent "${toAgent}" not registered`);
    }
    const task = this.createTask(toAgent, prompt, fromAgent);
    return this.executeTask(task.id);
  }

  private nextTaskId(): string {
    this.taskCounter++;
    return `task-${this.taskCounter}`;
  }

  private createTask(
    agentName: string,
    prompt: string,
    parentId?: string
  ): AgentTask {
    const now = Date.now();
    const task: AgentTask = {
      id: this.nextTaskId(),
      prompt,
      agentName,
      status: "pending",
      parentId,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  private updateTask(id: string, patch: Partial<AgentTask>): void {
    const task = this.tasks.get(id);
    if (!task) return;
    Object.assign(task, patch, { updatedAt: Date.now() });
  }

  private tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 2)
    );
  }

  private scoreAgent(agent: AgentConfig, tokens: Set<string>): number {
    const haystack = `${agent.name} ${agent.description}`.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (haystack.includes(token)) score++;
    }
    return score;
  }

  private buildToolSet(): ToolSet {
    const toolSet: ToolSet = {};
    for (const tool of this.tools.values()) {
      toolSet[tool.name] = dynamicTool({
        description: tool.description,
        inputSchema: jsonSchema({
          type: "object",
          additionalProperties: true,
        }),
        execute: async (input) => tool.execute(asRecord(input)),
      });
    }
    return toolSet;
  }

  private async executeTask(
    taskId: string,
    onToolCall?: (toolName: string, args: Record<string, unknown>) => void
  ): Promise<AgentRunResult> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found`);

    const agent = this.agents.get(task.agentName);
    if (!agent) {
      this.updateTask(taskId, {
        status: "failed",
        error: `Agent "${task.agentName}" not registered`,
      });
      throw new Error(`Agent "${task.agentName}" not registered`);
    }
    if (!this.model) {
      this.updateTask(taskId, {
        status: "failed",
        error: "No model set. Call setModel() first.",
      });
      throw new Error("No model set. Call setModel() first.");
    }

    this.updateTask(taskId, { status: "running" });
    const maxIterations = agent.maxIterations || 5;

    try {
      const result = await generateText({
        model: this.model,
        system: agent.systemPrompt,
        messages: [{ role: "user", content: task.prompt }],
        tools: this.buildToolSet(),
        stopWhen: stepCountIs(maxIterations),
      });

      const iterations = result.steps.length;
      let toolCalls = 0;
      for (const step of result.steps) {
        for (const call of step.toolCalls) {
          toolCalls++;
          if (onToolCall) onToolCall(call.toolName, asRecord(call.input));
        }
      }

      const finalText =
        result.text || "Max iterations reached without final answer.";
      this.updateTask(taskId, { status: "completed", result: finalText });
      return { text: finalText, iterations, toolCalls };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.updateTask(taskId, { status: "failed", error: message });
      throw err;
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
