import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import type { AgentConfig } from "./orchestrator.js";

export class AgentLoader {
  private agentDirs: string[];

  constructor(agentDirs: string[]) {
    this.agentDirs = agentDirs;
  }

  loadAgents(): AgentConfig[] {
    const agents: AgentConfig[] = [];
    for (const dir of this.agentDirs) {
      if (!existsSync(dir)) continue;
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry.endsWith(".md")) {
          const fullPath = join(dir, entry);
          const agent = this.parseAgentFile(fullPath);
          if (agent) agents.push(agent);
        }
      }
    }
    return agents;
  }

  private parseAgentFile(filePath: string): AgentConfig | null {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const { data, content } = matter(raw);

      if (!data.name) return null;

      return {
        name: data.name,
        description: data.description || "",
        systemPrompt: content.trim(),
        model: data.model,
        tools: data.tools || [],
        maxIterations: data.maxIterations || 5,
      };
    } catch {
      return null;
    }
  }
}

export function createAgent(config: AgentConfig): AgentConfig {
  return { ...config };
}
