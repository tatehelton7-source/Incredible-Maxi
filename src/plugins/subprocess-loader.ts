import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Tool, ToolResult } from "../tools/types.js";
import type { PluginContext } from "./types.js";
import { scrubEnv } from "../tools/env.js";

interface SubprocessPluginConfig {
  name: string;
  version: string;
  description: string;
  command: string;
  args: string[];
  cwd?: string;
  tools: Array<{
    name: string;
    description: string;
  }>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: ToolResult;
  error?: { code: number; message: string };
}

export class SubprocessPluginLoader {
  private processes: Map<string, ChildProcess> = new Map();
  private configs: Map<string, SubprocessPluginConfig> = new Map();
  private requestId = 0;
  private pendingRequests: Map<number, { resolve: (v: JsonRpcResponse) => void; reject: (e: Error) => void; timeout: NodeJS.Timeout }> = new Map();

  async loadPlugin(configPath: string, context: PluginContext): Promise<boolean> {
    const fullPath = resolve(configPath);
    if (!existsSync(fullPath)) return false;

    try {
      const { readFileSync } = await import("node:fs");
      const raw = readFileSync(fullPath, "utf-8");
      const config: SubprocessPluginConfig = JSON.parse(raw);

      if (!config.name || !config.command) return false;

      const proc = spawn(config.command, config.args, {
        cwd: config.cwd || process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        env: scrubEnv(),
      });

      this.processes.set(config.name, proc);
      this.configs.set(config.name, config);

      this.setupMessageHandler(proc, config.name);

      for (const toolDef of config.tools) {
        const tool: Tool = {
          name: toolDef.name,
          description: toolDef.description,
          execute: async (args) => {
            return this.callTool(config.name, toolDef.name, args);
          },
        };
        context.registerTool(tool);
      }

      return true;
    } catch {
      return false;
    }
  }

  private setupMessageHandler(proc: ChildProcess, pluginName: string): void {
    let buffer = "";
    proc.stdout?.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response: JsonRpcResponse = JSON.parse(line);
          const pending = this.pendingRequests.get(response.id);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingRequests.delete(response.id);
            pending.resolve(response);
          }
        } catch {
          // Ignore malformed lines
        }
      }
    });

    proc.on("error", () => {
      for (const [, pending] of this.pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`Plugin "${pluginName}" process error`));
      }
      this.pendingRequests.clear();
    });
  }

  private async callTool(
    pluginName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<ToolResult> {
    const proc = this.processes.get(pluginName);
    if (!proc || !proc.stdin || !proc.stdin.writable) {
      return { success: false, output: "", error: `Plugin "${pluginName}" not running` };
    }

    const id = ++this.requestId;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method: toolName,
      params: args,
    };

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        resolve({
          success: false,
          output: "",
          error: `Plugin "${pluginName}" tool "${toolName}" timed out`,
        });
      }, 30000);

      this.pendingRequests.set(id, {
        resolve: (response: JsonRpcResponse) => {
          if (response.error) {
            resolve({ success: false, output: "", error: response.error.message });
          } else if (response.result) {
            resolve(response.result);
          } else {
            resolve({ success: false, output: "", error: "Empty response from plugin" });
          }
        },
        reject: (err: Error) => {
          resolve({ success: false, output: "", error: err.message });
        },
        timeout,
      });

      if (proc.stdin) {
        proc.stdin.write(JSON.stringify(request) + "\n");
      }
    });
  }

  async destroyPlugin(name: string): Promise<void> {
    const proc = this.processes.get(name);
    if (proc) {
      proc.kill();
      this.processes.delete(name);
    }
    this.configs.delete(name);
  }

  async destroyAll(): Promise<void> {
    const names = [...this.processes.keys()];
    for (const name of names) {
      await this.destroyPlugin(name);
    }
  }

  listPlugins(): SubprocessPluginConfig[] {
    return [...this.configs.values()];
  }
}
