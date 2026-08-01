import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Tool as McpToolDef } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "../tools/types.js";

export class McpServer {
  private server: Server;
  private tools: Map<string, Tool> = new Map();

  constructor() {
    this.server = new Server(
      { name: "maxi", version: "0.1.0" },
      { capabilities: { tools: {} } }
    );

    this.setupHandlers();
  }

  registerTool(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  registerTools(tools: Tool[]): void {
    for (const tool of tools) {
      this.registerTool(tool);
    }
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(
      { method: "tools/list" } as never,
      async () => {
        const tools: McpToolDef[] = [...this.tools.values()].map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: {
            type: "object" as const,
            properties: {},
          },
        }));
        return { tools };
      }
    );

    this.server.setRequestHandler(
      { method: "tools/call" } as never,
      async (request: { params: { name: string; arguments?: Record<string, unknown> } }) => {
        const tool = this.tools.get(request.params.name);
        if (!tool) {
          return {
            content: [{ type: "text", text: `Tool "${request.params.name}" not found` }],
            isError: true,
          };
        }

        const result = await tool.execute(request.params.arguments || {});
        return {
          content: [{ type: "text", text: result.output || result.error || "" }],
          isError: !result.success,
        };
      }
    );
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}
