import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MaxiPlugin, PluginContext } from "./types.js";
import type { Tool } from "../tools/types.js";

export class TSPluginLoader {
  private plugins: Map<string, MaxiPlugin> = new Map();
  private tools: Map<string, Tool> = new Map();

  async loadPlugin(pluginPath: string, context: PluginContext): Promise<boolean> {
    const fullPath = resolve(pluginPath);
    if (!existsSync(fullPath)) {
      return false;
    }

    try {
      const fileUrl = pathToFileURL(fullPath).href;
      const mod = await import(fileUrl);
      const plugin: MaxiPlugin = mod.default || mod;

      if (!plugin.name || !plugin.version) {
        return false;
      }

      this.plugins.set(plugin.name, plugin);

      if (plugin.tools) {
        for (const tool of plugin.tools) {
          this.tools.set(tool.name, tool);
          context.registerTool(tool);
        }
      }

      if (plugin.onInit) {
        await plugin.onInit(context);
      }

      return true;
    } catch {
      return false;
    }
  }

  async loadFromDir(dir: string, context: PluginContext): Promise<string[]> {
    const loaded: string[] = [];
    if (!existsSync(dir)) return loaded;

    const { readdirSync } = await import("node:fs");
    const entries = readdirSync(dir);

    for (const entry of entries) {
      if (entry.endsWith(".js") || entry.endsWith(".mjs")) {
        const pluginPath = join(dir, entry);
        const success = await this.loadPlugin(pluginPath, context);
        if (success) loaded.push(entry);
      }
    }

    return loaded;
  }

  getPlugin(name: string): MaxiPlugin | undefined {
    return this.plugins.get(name);
  }

  listPlugins(): MaxiPlugin[] {
    return [...this.plugins.values()];
  }

  async destroyPlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (plugin?.onDestroy) {
      await plugin.onDestroy();
    }
    this.plugins.delete(name);
    if (plugin?.tools) {
      for (const tool of plugin.tools) {
        this.tools.delete(tool.name);
      }
    }
  }

  async destroyAll(): Promise<void> {
    const names = [...this.plugins.keys()];
    for (const name of names) {
      await this.destroyPlugin(name);
    }
  }
}
