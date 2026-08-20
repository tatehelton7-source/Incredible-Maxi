import * as readline from "node:readline";
import { stdin, stdout } from "node:process";
import chalk from "chalk";
import { streamText } from "ai";
import type { LanguageModel } from "ai";
import type { MaxiConfig } from "./providers/types.js";
import { ContextEngine } from "./context/engine.js";
import type { AgentOrchestrator } from "./agents/orchestrator.js";
import fetch from "node-fetch";

export interface ReplOptions {
  model: LanguageModel;
  contextEngine: ContextEngine;
  orchestrator?: AgentOrchestrator;
  systemPrompt?: string;
  provider?: string;
  modelName?: string;
  registry?: ReturnType<typeof import("./providers/registry.js").buildRegistry>;
  config?: MaxiConfig;
}

export class Repl {
  private rl: readline.Interface;
  private model: LanguageModel;
  private contextEngine: ContextEngine;
  private orchestrator: AgentOrchestrator | undefined;
  private systemPrompt: string;
  private history: Array<{ role: "user" | "assistant"; content: string }> = [];
  private running = false;
  private provider: string;
  private modelName: string;
  private registry: ReturnType<typeof import("./providers/registry.js").buildRegistry> | undefined;

  constructor(opts: ReplOptions) {
    this.model = opts.model;
    this.contextEngine = opts.contextEngine;
    this.orchestrator = opts.orchestrator;
    this.systemPrompt = opts.systemPrompt || "You are Maxi, a helpful AI coding assistant.";
    this.provider = opts.provider || "nvidia";
    this.modelName = opts.modelName || "meta/llama-3.1-8b-instruct";
    this.registry = opts.registry;
    this.rl = readline.createInterface({
      input: stdin,
      output: stdout,
      prompt: chalk.cyan("maxi> "),
    });
  }

  async start(): Promise<void> {
    this.running = true;
    console.log(chalk.cyan.bold("\n  Maxi — Interactive Mode\n"));
    console.log(chalk.dim("  Type your message and press Enter. Type /help for commands, /exit to quit.\n"));

    await this.contextEngine.indexCodebase();
    console.log(chalk.dim(`  Indexed ${this.contextEngine.getFileCount()} files in the codebase.\n`));
    console.log(chalk.dim(`  Model: ${this.provider}/${this.modelName}\n`));

    this.rl.prompt();

    this.rl.on("line", async (input: string) => {
      const trimmed = input.trim();
      if (!trimmed) {
        this.rl.prompt();
        return;
      }

      if (trimmed === "/exit" || trimmed === "/quit") {
        this.stop();
        return;
      }

      if (trimmed === "/help") {
        this.printHelp();
        this.rl.prompt();
        return;
      }

      if (trimmed === "/clear") {
        this.history = [];
        console.log(chalk.dim("  Conversation cleared.\n"));
        this.rl.prompt();
        return;
      }

      if (trimmed === "/files") {
        console.log(this.contextEngine.getFileTree());
        this.rl.prompt();
        return;
      }

      if (trimmed === "/models") {
        await this.handleModelsCommand();
        this.rl.prompt();
        return;
      }

      if (trimmed.startsWith("/agent ")) {
        await this.handleAgentCommand(trimmed.slice(7));
        this.rl.prompt();
        return;
      }

      await this.handleChat(trimmed);
      this.rl.prompt();
    });

    this.rl.on("close", () => {
      console.log(chalk.dim("\n  Goodbye.\n"));
      process.exit(0);
    });
  }

  private async handleModelsCommand(): Promise<void> {
    if (!this.registry) {
      console.log(chalk.dim("  Model switching not available (no provider registry).\n"));
      return;
    }

    console.log(chalk.dim("  Fetching available models...\n"));

    try {
      let models: string[] = [];

      if (this.provider === "nvidia") {
        // Fetch from NVIDIA API
        const response = await fetch("https://integrate.api.nvidia.com/v1/models", {
          headers: {
            Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
          },
        });
        const data = (await response.json()) as { data: Array<{ id: string }> };
        models = data.data
          .filter((m) => m.id.includes("instruct") || m.id.includes("chat") || m.id.includes("nemotron"))
          .map((m) => m.id)
          .sort();
      } else if (this.provider === "openai") {
        models = ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"];
      } else if (this.provider === "anthropic") {
        models = ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-5"];
      } else {
        console.log(chalk.dim("  Model listing not implemented for this provider.\n"));
        return;
      }

      if (models.length === 0) {
        console.log(chalk.dim("  No models found.\n"));
        return;
      }

      console.log(chalk.cyan("  Available models:"));
      models.forEach((m, i) => {
        const current = m === this.modelName ? chalk.green(" ← current") : "";
        console.log(chalk.dim(`    ${i + 1}. ${m}${current}`));
      });
      console.log();

      // Ask user to select
      const selection = await this.askQuestion(chalk.cyan("  Select model number (or Enter to cancel): "));
      const num = parseInt(selection.trim(), 10);
      if (!isNaN(num) && num >= 1 && num <= models.length) {
        const newModel = models[num - 1];
        try {
          this.model = this.registry.languageModel(`${this.provider}:${newModel}`);
          this.modelName = newModel;
          console.log(chalk.green(`  Switched to ${this.provider}/${newModel}\n`));
        } catch (err) {
          console.error(chalk.red(`  Failed to switch model: ${(err as Error).message}\n`));
        }
      } else {
        console.log(chalk.dim("  Cancelled.\n"));
      }
    } catch (err) {
      console.error(chalk.red(`  Failed to fetch models: ${(err as Error).message}\n`));
    }
  }

  private askQuestion(question: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question(question, (answer) => resolve(answer));
    });
  }

  private async handleChat(input: string): Promise<void> {
    this.history.push({ role: "user", content: input });

    const context = await this.contextEngine.getContextForPrompt(input, 8000);
    const messages = this.history.map((h) => ({
      role: h.role,
      content: h.content,
    }));

    process.stdout.write(chalk.dim("  "));
    try {
      const result = streamText({
        model: this.model,
        system: `${this.systemPrompt}\n\n# Codebase Context\n${context}`,
        messages,
      });

      let fullText = "";
      for await (const textPart of result.textStream) {
        process.stdout.write(textPart);
        fullText += textPart;
      }
      process.stdout.write("\n\n");

      this.history.push({ role: "assistant", content: fullText });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\n  Error: ${message}\n`));
    }
  }

  private async handleAgentCommand(input: string): Promise<void> {
    if (!this.orchestrator) {
      console.log(chalk.dim("  Agent orchestrator not configured.\n"));
      return;
    }

    const parts = input.split(/\s+/);
    const agentName = parts[0];
    const prompt = parts.slice(1).join(" ");

    if (!agentName || !prompt) {
      console.log(chalk.dim("  Usage: /agent <agent-name> <prompt>\n"));
      return;
    }

      const agent = this.orchestrator.getAgent(agentName);
    if (!agent) {
      console.log(chalk.dim(`  Agent "${agentName}" not found. Available: ${this.orchestrator.listAgents().map((a: { name: string }) => a.name).join(", ")}\n`));
      return;
    }

    console.log(chalk.dim(`  Running agent "${agentName}"...\n`));
    try {
      const result = await this.orchestrator.runAgent(agentName, prompt, (toolName: string, _args: Record<string, unknown>) => {
        console.log(chalk.dim(`  [tool: ${toolName}]`));
      });
      console.log(result.text + "\n");
    } catch (err) {
      console.error(chalk.red(`  Agent error: ${(err as Error).message}\n`));
    }
  }

  private printHelp(): void {
    console.log(chalk.dim("\n  Commands:"));
    console.log(chalk.dim("    /help     — Show this help"));
    console.log(chalk.dim("    /clear    — Clear conversation history"));
    console.log(chalk.dim("    /files    — Show indexed file tree"));
    console.log(chalk.dim("    /models   — List and switch models"));
    console.log(chalk.dim("    /agent <name> <prompt> — Run a specific agent"));
    console.log(chalk.dim("    /exit     — Exit Maxi\n"));
  }

  stop(): void {
    this.running = false;
    this.rl.close();
  }

  isRunning(): boolean {
    return this.running;
  }
}
