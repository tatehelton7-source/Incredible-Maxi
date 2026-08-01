import type { Tool, ToolResult } from "../tools/types.js";

export interface MaxiPlugin {
  name: string;
  version: string;
  description: string;
  tools?: Tool[];
  onInit?: (context: PluginContext) => void | Promise<void>;
  onDestroy?: () => void | Promise<void>;
}

export interface PluginContext {
  cwd: string;
  registerTool: (tool: Tool) => void;
  getTool: (name: string) => Tool | undefined;
  log: (message: string) => void;
}
