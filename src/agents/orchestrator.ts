import { generateText, type LanguageModel } from "ai";
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
}

export interface AgentRunResult {
  text: string;
  iterations: number;
  toolCalls: number;
}

export class AgentOrchestrator {
  private agents: Map<string, AgentConfig> = new Map();
  private tools: Map<string, Tool> = new Map();
  private model: LanguageModel | null = null;

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

  async runAgent(
    agentName: string,
    prompt: string,
    onToolCall?: (toolName: string, args: Record<string, unknown>) => void
  ): Promise<AgentRunResult> {
    const agent = this.agents.get(agentName);
    if (!agent) throw new Error(`Agent "${agentName}" not registered`);
    if (!this.model) throw new Error("No model set. Call setModel() first.");

    const maxIterations = agent.maxIterations || 5;
    let currentPrompt = prompt;
    let iterations = 0;
    let toolCalls = 0;
    let finalText = "";

    for (let i = 0; i < maxIterations; i++) {
      iterations++;
      const { text } = await generateText({
        model: this.model,
        system: agent.systemPrompt,
        prompt: currentPrompt,
      });

      const toolInvocation = this.parseToolCall(text);
      if (!toolInvocation) {
        finalText = text;
        break;
      }

      toolCalls++;
      if (onToolCall) onToolCall(toolInvocation.tool, toolInvocation.args);

      const tool = this.tools.get(toolInvocation.tool);
      if (!tool) {
        currentPrompt = `${prompt}\n\nPrevious attempt tried to use tool "${toolInvocation.tool}" which is not available. Available tools: ${this.listTools().map((t) => t.name).join(", ")}. Try again.`;
        continue;
      }

      const result = await tool.execute(toolInvocation.args);
      currentPrompt = `${prompt}\n\nTool "${toolInvocation.tool}" returned:\n${result.output}\n\nContinue based on this result.`;
    }

    if (!finalText) finalText = "Max iterations reached without final answer.";

    return { text: finalText, iterations, toolCalls };
  }

  async runParallel(
    tasks: { agentName: string; prompt: string }[]
  ): Promise<AgentRunResult[]> {
    return Promise.all(
      tasks.map((task) => this.runAgent(task.agentName, task.prompt))
    );
  }

  private parseToolCall(text: string): { tool: string; args: Record<string, unknown> } | null {
    const match = text.match(/```tool\n([\s\S]*?)```/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.tool && parsed.args) {
        return { tool: parsed.tool, args: parsed.args };
      }
    } catch {
      return null;
    }
    return null;
  }
}
