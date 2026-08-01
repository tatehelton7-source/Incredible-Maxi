import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool, ToolResult } from "../tools/types.js";

interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export class McpClient {
  private clients: Map<string, Client> = new Map();
  private transports: Map<string, StdioClientTransport> = new Map();
  private tools: Map<string, Tool[]> = new Map();

  async connect(config: McpServerConfig): Promise<boolean> {
    try {
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        env: { ...process.env, ...config.env } as Record<string, string>,
      });

      const client = new Client(
        { name: "maxi", version: "0.1.0" },
        { capabilities: {} }
      );

      await client.connect(transport);
      this.clients.set(config.name, client);
      this.transports.set(config.name, transport);

      await this.discoverTools(config.name);
      return true;
    } catch {
      return false;
    }
  }

  private async discoverTools(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    if (!client) return;

    try {
      const response = await client.listTools();
      const tools: Tool[] = (response.tools || []).map((mcpTool) => ({
        name: `${serverName}__${mcpTool.name}`,
        description: mcpTool.description || "",
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
          return this.callTool(serverName, mcpTool.name, args);
        },
      }));
      this.tools.set(serverName, tools);
    } catch {
      this.tools.set(serverName, []);
    }
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<ToolResult> {
    const client = this.clients.get(serverName);
    if (!client) {
      return { success: false, output: "", error: `MCP server "${serverName}" not connected` };
    }

    try {
      const result = await client.callTool({
        name: toolName,
        arguments: args,
      });

      const content = (result.content || []) as Array<{ type: string; text?: string }>;
      const textParts = content
        .filter((c) => c.type === "text")
        .map((c) => c.text || "")
        .join("\n");

      return { success: !result.isError, output: textParts };
    } catch (err) {
      return { success: false, output: "", error: `MCP tool call failed: ${(err as Error).message}` };
    }
  }

  getAllTools(): Tool[] {
    return [...this.tools.values()].flat();
  }

  getTools(serverName: string): Tool[] {
    return this.tools.get(serverName) || [];
  }

  listServers(): string[] {
    return [...this.clients.keys()];
  }

  async disconnect(serverName: string): Promise<void> {
    const transport = this.transports.get(serverName);
    if (transport) {
      await transport.close();
      this.transports.delete(serverName);
    }
    this.clients.delete(serverName);
    this.tools.delete(serverName);
  }

  async disconnectAll(): Promise<void> {
    const names = [...this.clients.keys()];
    for (const name of names) {
      await this.disconnect(name);
    }
  }
}
