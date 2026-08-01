import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Tool, ToolResult } from "../tools/types.js";
import type { MaxiPlugin, PluginContext } from "./types.js";

interface WasmPluginConfig {
  name: string;
  version: string;
  description: string;
  wasmPath: string;
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
}

export class WasmPluginLoader {
  private plugins: Map<string, WasmPluginConfig> = new Map();

  async loadPlugin(configPath: string, context: PluginContext): Promise<boolean> {
    const fullPath = resolve(configPath);
    if (!existsSync(fullPath)) return false;

    try {
      const raw = readFileSync(fullPath, "utf-8");
      const config: WasmPluginConfig = JSON.parse(raw);

      if (!config.name || !config.wasmPath) return false;

      const wasmFullPath = resolve(config.wasmPath);
      if (!existsSync(wasmFullPath)) return false;

      this.plugins.set(config.name, config);

      for (const toolDef of config.tools) {
        const tool: Tool = {
          name: toolDef.name,
          description: toolDef.description,
          execute: async (args) => {
            return this.executeWasm(wasmFullPath, toolDef.name, args);
          },
        };
        context.registerTool(tool);
      }

      return true;
    } catch {
      return false;
    }
  }

  private async executeWasm(
    wasmPath: string,
    functionName: string,
    args: Record<string, unknown>
  ): Promise<ToolResult> {
    try {
      const { readFile } = await import("node:fs/promises");
      const wasmBytes = await readFile(wasmPath);

      const importObject = {
        env: {
          memory: new WebAssembly.Memory({ initial: 256 }),
          log: (value: number) => {
            context_log(`WASM log: ${value}`);
          },
        },
      };

      const wasmModule = await WebAssembly.instantiate(wasmBytes, importObject);
      const exports = wasmModule.instance.exports as Record<string, unknown>;

      const func = exports[functionName];
      if (typeof func !== "function") {
        return {
          success: false,
          output: "",
          error: `WASM function "${functionName}" not found in module`,
        };
      }

      const inputStr = JSON.stringify(args);
      const inputPtr = this.writeStringToWasm(wasmModule, inputStr);
      const resultPtr = (func as (ptr: number) => number)(inputPtr);
      const output = this.readStringFromWasm(wasmModule, resultPtr);

      return { success: true, output };
    } catch (err) {
      return {
        success: false,
        output: "",
        error: `WASM execution failed: ${(err as Error).message}`,
      };
    }
  }

  private writeStringToWasm(
    module: WebAssembly.WebAssemblyInstantiatedSource,
    str: string
  ): number {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);
    const memory = module.instance.exports.memory as WebAssembly.Memory;
    const buffer = new Uint8Array(memory.buffer);
    const ptr = 0;
    for (let i = 0; i < bytes.length; i++) {
      buffer[ptr + i] = bytes[i];
    }
    buffer[ptr + bytes.length] = 0;
    return ptr;
  }

  private readStringFromWasm(
    module: WebAssembly.WebAssemblyInstantiatedSource,
    ptr: number
  ): string {
    const memory = module.instance.exports.memory as WebAssembly.Memory;
    const buffer = new Uint8Array(memory.buffer, ptr);
    let end = ptr;
    while (buffer[end - ptr] !== 0) end++;
    const bytes = buffer.slice(0, end - ptr);
    return new TextDecoder().decode(bytes);
  }

  listPlugins(): WasmPluginConfig[] {
    return [...this.plugins.values()];
  }
}

function context_log(message: string): void {
  // Placeholder for plugin logging — wired by PluginContext
}
