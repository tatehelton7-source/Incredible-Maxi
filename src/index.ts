import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline";
import { Command } from "commander";
import chalk from "chalk";
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import { AgentOrchestrator } from "./agents/orchestrator.js";
import { AutomationEngine } from "./automation/engine.js";
import { AcpClient, AcpServer } from "./acp/adapter.js";
import { buildToolRegistry } from "./tools/registry.js";
import { loadConfig, validateConfig } from "./config.js";
import { buildRegistry, resolveModel } from "./providers/registry.js";
import { ContextEngine } from "./context/engine.js";
import { Repl } from "./repl.js";
import { discoverAll } from "./models/registry.js";
import { runSelectorUI } from "./ui/selector.js";
import { runConfigureUI } from "./ui/configure.js";
import { enableVtProcessing } from "./ui/terminal.js";
import { McpClient } from "./mcp/client.js";
import { TSPluginLoader } from "./plugins/ts-loader.js";
import { WasmPluginLoader } from "./plugins/wasm-loader.js";
import { SubprocessPluginLoader } from "./plugins/subprocess-loader.js";
import type { PluginContext } from "./plugins/types.js";
import type { Tool } from "./tools/types.js";
import type { MaxiConfig } from "./providers/types.js";
import { SnapshotManager } from "./snapshots.js";
import { SessionStore } from "./session/store.js";
import { inspectSession, renderSummary } from "./session/inspect.js";

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

function createOrchestrator(model: LanguageModel, config: MaxiConfig): AgentOrchestrator {
  const orchestrator = new AgentOrchestrator();
  orchestrator.setModel(model);
  for (const tool of buildToolRegistry(config)) {
    orchestrator.registerTool(tool);
  }
  const names = config.agents && config.agents.length > 0 ? config.agents : ["builder", "researcher", "reviewer"];
  const defaults: Record<string, { description: string; systemPrompt: string }> = {
    builder: {
      description: "Implements code changes, writes and edits files, runs builds and tests",
      systemPrompt:
        "You are the builder agent. Implement the requested changes: write code, edit files, run builds and tests, and report what you did.",
    },
    researcher: {
      description: "Researches codebases and external sources, reads files and documentation",
      systemPrompt:
        "You are the researcher agent. Investigate the codebase and external sources to answer questions and gather facts.",
    },
    reviewer: {
      description: "Reviews code for quality, security, and correctness",
      systemPrompt:
        "You are the reviewer agent. Review code changes for quality, security, and correctness, and report findings.",
    },
  };
  for (const name of names) {
    const def = defaults[name] ?? {
      description: `Agent "${name}"`,
      systemPrompt: `You are the "${name}" agent. Complete the user's request to the best of your ability.`,
    };
    orchestrator.registerAgent({ name, description: def.description, systemPrompt: def.systemPrompt });
  }
  return orchestrator;
}

async function selectModelInteractively(config: MaxiConfig): Promise<{ provider: string; model: string } | null> {
  process.stdout.write(chalk.dim("  Discovering models...\n"));
  let snapshot = await discoverAll(config);
  process.stdout.write("\x1b[1A\x1b[2K");
  for (;;) {
    const result = await runSelectorUI(snapshot, () => discoverAll(config));
    if (result.action === "select") {
      // resetStdinForReadline();
      return { provider: result.provider, model: result.model };
    }
    if (result.action === "configure") {
      await runConfigureUI(config);
      process.stdout.write(chalk.dim("  Discovering models...\n"));
      snapshot = await discoverAll(config);
      process.stdout.write("\x1b[1A\x1b[2K");
      continue;
    }
    // resetStdinForReadline();
    return null;
  }
}

/** Ensure stdin is in a clean state for readline after selector usage. */
function resetStdinForReadline(): void {
  const stdin = process.stdin;
  if (stdin.isTTY) {
    stdin.setRawMode(false);
    // Remove all keypress listeners; readline will add its own when created
    const listeners = stdin.listeners("keypress");
    for (const listener of listeners) {
      stdin.removeListener("keypress", listener);
    }
    // Do NOT call emitKeypressEvents here; readline will do it when created
    // Do NOT pause stdin - this may cause readline to be closed
  }
}

/**
 * Project-level hygiene (Phase 2): if a `.gitignore` exists in the cwd and does
 * not already ignore `.maxi/`, append it. Session logs may contain secrets.
 */
function ensureGitignoreHygiene(): void {
  const gitignorePath = join(process.cwd(), ".gitignore");
  if (!existsSync(gitignorePath)) return;
  const content = readFileSync(gitignorePath, "utf-8");
  const hasEntry = content.split("\n").some((l) => l.trim() === ".maxi/");
  if (hasEntry) return;
  const suffix = content.endsWith("\n") ? ".maxi/\n" : "\n.maxi/\n";
  writeFileSync(gitignorePath, content + suffix, "utf-8");
}

const program = new Command();

program
  .name("maxi")
  .description("Maxi — Lightweight multi-language AI coding CLI")
  .version("0.1.0")
  .argument("[prompt]", "One-shot prompt (omit for interactive mode)")
  .option("-p, --provider <name>", "LLM provider (openai, anthropic, omniroute)", "")
  .option("-m, --model <name>", "Model ID (e.g. gpt-4o, claude-sonnet-4-5)", "")
  .option("--resume <id>", "Resume a previous session by id")
  .option("--fork <id>", "Fork a previous session by id")
  .action(async (prompt: string | undefined, opts: { provider: string; model: string; resume?: string; fork?: string }) => {
    // Enable ANSI/VT processing on Windows so the TUI's escape sequences
    // (clear screen, cursor positioning) actually work instead of being
    // written as literal bytes and ignored.
    enableVtProcessing();

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

    const mcpClient = new McpClient();
    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
      const results: Array<{ name: string; ok: boolean }> = [];
      for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
        const ok = await mcpClient.connect({ name, ...serverConfig });
        results.push({ name, ok });
      }
      const connected = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      if (connected.length > 0) {
        console.log(chalk.green(`  MCP: ${connected.length} server(s) connected (${connected.map((r) => r.name).join(", ")})`));
      }
      if (failed.length > 0) {
        console.log(chalk.yellow(`  MCP: ${failed.length} server(s) failed (${failed.map((r) => r.name).join(", ")})`));
      }
      const mcpToolCount = mcpClient.getAllTools().length;
      if (mcpToolCount > 0) {
        console.log(chalk.dim(`  MCP: ${mcpToolCount} tool(s) loaded`));
      }
    }

    const pluginTools: Tool[] = [];
    const loadedPlugins: Array<{ name: string; description: string; tools: string[] }> = [];
    let destroyPlugins: (() => Promise<void>) | undefined;

    if (config.plugins && config.plugins.length > 0) {
      const toolRegistry = new Map<string, Tool>();
      const pluginContext: PluginContext = {
        cwd: process.cwd(),
        registerTool: (tool) => toolRegistry.set(tool.name, tool),
        getTool: (name) => toolRegistry.get(name),
        log: (msg) => console.log(chalk.dim(`  [plugin] ${msg}`)),
      };

      const tsLoader = new TSPluginLoader();
      const wasmLoader = new WasmPluginLoader();
      const subprocessLoader = new SubprocessPluginLoader();

      for (const pc of config.plugins) {
        try {
          let ok = false;
          switch (pc.type) {
            case "ts":
              ok = await tsLoader.loadPlugin(pc.path, pluginContext);
              break;
            case "wasm":
              ok = await wasmLoader.loadPlugin(pc.path, pluginContext);
              break;
            case "subprocess":
              ok = await subprocessLoader.loadPlugin(pc.path, pluginContext);
              break;
          }
          if (!ok) {
            console.log(chalk.yellow(`  Plugin failed to load: ${pc.path}`));
          }
        } catch (err) {
          console.log(chalk.yellow(`  Plugin error (${pc.path}): ${(err as Error).message}`));
        }
      }

      for (const p of tsLoader.listPlugins()) {
        loadedPlugins.push({ name: p.name, description: p.description, tools: p.tools?.map((t) => t.name) ?? [] });
      }
      for (const p of wasmLoader.listPlugins()) {
        loadedPlugins.push({ name: p.name, description: p.description, tools: p.tools.map((t) => t.name) });
      }
      for (const p of subprocessLoader.listPlugins()) {
        loadedPlugins.push({ name: p.name, description: p.description, tools: p.tools.map((t) => t.name) });
      }

      pluginTools.push(...toolRegistry.values());
      destroyPlugins = async () => {
        await tsLoader.destroyAll();
        await subprocessLoader.destroyAll();
      };

      if (loadedPlugins.length > 0) {
        console.log(chalk.green(`  Plugins: ${loadedPlugins.length} loaded, ${pluginTools.length} tool(s)`));
      }
    }

    if (!prompt) {
      ensureGitignoreHygiene();
      const sessionStore = new SessionStore();
      let sessionId: string | undefined;
      let resume = false;
      if (opts.resume) {
        sessionId = opts.resume;
        resume = true;
      } else if (opts.fork) {
        sessionId = await sessionStore.fork(opts.fork);
        console.log(chalk.dim(`  Forked session ${opts.fork} → ${sessionId}\n`));
      } else {
        sessionId = await sessionStore.createSession();
      }

      const snapshotManager = new SnapshotManager(process.cwd(), sessionId);
      const contextEngine = new ContextEngine(process.cwd());
      const orchestrator = createOrchestrator(languageModel, config);
      const automationEngine = new AutomationEngine(process.cwd(), orchestrator);
      automationEngine.start();
      const acpClient = new AcpClient({
        command: process.env.MAXI_ACP_AGENT_COMMAND ?? "maxi-acp-agent",
        cwd: process.cwd(),
      });
      const acpServer = new AcpServer({ orchestrator });
      const repl = new Repl({
        model: languageModel,
        contextEngine,
        provider,
        modelName: model,
        registry,
        config,
        mcpClient,
        pluginTools,
        loadedPlugins,
        destroyPlugins,
        snapshotManager,
        orchestrator,
        automationEngine,
        acpClient,
        acpServer,
        sessionStore,
        sessionId,
        resume,
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

/**
 * Phase 5 — Observability. `maxi session inspect <id>` and `maxi session list`
 * read the on-disk JSONL event log directly. They never start the REPL, never
 * touch a model/provider, and never require API keys.
 */
const sessionCmd = program.command("session").description("Inspect and list durable sessions");

sessionCmd
  .command("inspect <id>")
  .description("Render a one-screen summary of a session from its event log")
  .action(async (id: string) => {
    const store = new SessionStore();
    const events = await store.readAll(id);
    if (events.length === 0) {
      console.error(chalk.red(`No session found with id "${id}"`));
      process.exit(1);
    }
    console.log(renderSummary(inspectSession(events)));
  });

sessionCmd
  .command("list")
  .description("List all sessions: id, started at, last event type, event count")
  .action(async () => {
    const store = new SessionStore();
    const ids = await store.list();
    if (ids.length === 0) {
      console.log(chalk.dim("  No sessions found."));
      return;
    }
    for (const id of ids) {
      const events = await store.readAll(id);
      const last = events[events.length - 1];
      const started = events[0] ? new Date(events[0].ts).toISOString() : "unknown";
      const lastType = last ? last.type : "none";
      console.log(`  ${id}  ${started}  ${lastType}  ${events.length} events`);
    }
  });

program.parse();
