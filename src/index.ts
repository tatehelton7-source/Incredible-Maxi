import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { generateText } from "ai";
import { loadConfig, validateConfig } from "./config.js";
import { buildRegistry, resolveModel } from "./providers/registry.js";
import { ContextEngine } from "./context/engine.js";
import { Repl } from "./repl.js";
import { discoverAll } from "./models/registry.js";
import { runSelectorUI } from "./ui/selector.js";
import { runConfigureUI } from "./ui/configure.js";
import type { MaxiConfig } from "./providers/types.js";

const STATE_DIR = join(homedir(), ".maxi");
const STATE_PATH = join(STATE_DIR, "state.json");

interface MaxiState {
  lastUsedModel?: { provider: string; model: string };
}

function loadState(): MaxiState {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as MaxiState;
  } catch {
    return {};
  }
}

function saveState(state: MaxiState): void {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf-8");
  } catch {
    // Non-fatal — quick-continue just won't be available next launch.
  }
}

async function selectModelInteractively(config: MaxiConfig): Promise<{ provider: string; model: string } | null> {
  let snapshot = await discoverAll(config);
  for (;;) {
    const result = await runSelectorUI(snapshot, () => discoverAll(config));
    if (result.action === "select") return { provider: result.provider, model: result.model };
    if (result.action === "configure") {
      await runConfigureUI(config);
      snapshot = await discoverAll(config);
      continue;
    }
    return null; // "quit" or "non_interactive"
  }
}

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

    let provider: string;
    let model: string;

    if (opts.provider || opts.model) {
      // Explicit -p/-m flags bypass the selector unconditionally — this is
      // what keeps scripted/CI invocations safe from ever blocking on a TUI.
      provider = opts.provider || config.defaultProvider;
      model = opts.model || config.defaultModel;
    } else if (!prompt && process.stdin.isTTY) {
      const state = loadState();
      const skipSelector = config.startupModelSelector === false && state.lastUsedModel;
      if (skipSelector) {
        provider = state.lastUsedModel!.provider;
        model = state.lastUsedModel!.model;
        console.log(chalk.dim(`  Continuing with ${provider}/${model} (use /models to switch)\n`));
      } else {
        const picked = await selectModelInteractively(config);
        if (picked) {
          provider = picked.provider;
          model = picked.model;
          saveState({ lastUsedModel: picked });
        } else {
          provider = config.defaultProvider;
          model = config.defaultModel;
        }
      }
    } else {
      provider = config.defaultProvider;
      model = config.defaultModel;
    }

    const error = validateConfig(config, provider);
    if (error) {
      console.error(chalk.red(error));
      process.exit(1);
    }

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
        config,
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
