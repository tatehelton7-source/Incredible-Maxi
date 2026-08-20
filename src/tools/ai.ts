import { z } from "zod";
import { zodSchema } from "ai";
import type { ToolSet } from "ai";
import type { Tool } from "./types.js";

const passthroughInput = zodSchema(z.record(z.string(), z.unknown()));

export function toAiTools(tools: Tool[]): ToolSet {
  const toolSet: ToolSet = {};
  for (const tool of tools) {
    toolSet[tool.name] = {
      description: tool.description,
      inputSchema: passthroughInput,
      execute: async (input: Record<string, unknown>) => {
        try {
          const result = await tool.execute(input);
          return result.success
            ? result.output
            : `Error: ${result.error ?? "Tool execution failed"}`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    };
  }
  return toolSet;
}
