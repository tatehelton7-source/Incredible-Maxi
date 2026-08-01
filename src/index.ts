#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import { generateText } from "ai";
import { loadConfig, validateConfig } from "./config.js";
import { buildRegistry, resolveModel } from "./providers/registry.js";
import { ContextEngine } from "./context/engine.js";
import { Repl } from "./repl.js";

const program = new Command();

program
  .name("maxi")
  .description("Maxi — Lightweight multi-language AI coding CLI")
  .version("0.1.0")
  .argument("[prompt]", "One-shot prompt (omit for interactive mode)")
  .option("-p, --provider <name>", "LLM provider (openai, anthropic, omniroute)", "")
  .option("-m, --model <name>", "Model ID (e.g. gpt-4o, claude-sonnet-4-5)", "")
  .action(async (prompt: string | undefined, opts: { provider: string; model: string }) => {
    const config = loadConfig();

    const error = validateConfig(config);
    if (error) {
      console.error(chalk.red(error));
      process.exit(1);
    }

    const provider = opts.provider || config.defaultProvider;
    const model = opts.model || config.defaultModel;

    // Vercel AI SDK reads API keys from env vars, not config objects
    if (config.openaiApiKey) process.env.OPENAI_API_KEY = config.openaiApiKey;
    if (config.anthropicApiKey) process.env.ANTHROPIC_API_KEY = config.anthropicApiKey;

    const registry = buildRegistry(config);
    const languageModel = resolveModel(registry, provider, model);

    if (!prompt) {
      const contextEngine = new ContextEngine(process.cwd());
      const repl = new Repl({ 
        model: languageModel, 
        contextEngine,
        provider,
        modelName: model,
        registry,
      });
      await repl.start();
      return;
    }

    try {
      const contextEngine = new ContextEngine(process.cwd());
      await contextEngine.indexCodebase();
      const context = await contextEngine.getContextForPrompt(prompt, 8000);

      console.log(chalk.dim(`Using ${provider}/${model}...`));
      const { text } = await generateText({
        model: languageModel,
        system: `You are Maxi, a helpful AI coding assistant.\n\n# Codebase Context\n${context}`,
        prompt,
      });

      console.log(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Error: ${message}`));
      process.exit(1);
    }
  });

program.parse();
