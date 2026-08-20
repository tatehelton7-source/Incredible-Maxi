import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { MaxiConfig } from "./providers/types.js";
import { DEFAULT_CONFIG } from "./providers/types.js";

/**
 * Load Maxi configuration from:
 * 1. Environment variables (highest priority)
 * 2. maxi.config.json in project root
 * 3. Defaults
 */
export function loadConfig(): MaxiConfig {
  let config: MaxiConfig = { ...DEFAULT_CONFIG };

  // Try loading maxi.config.json
  const configPath = resolve(process.cwd(), "maxi.config.json");
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      const fileConfig = JSON.parse(raw) as Partial<MaxiConfig>;
      config = { ...config, ...fileConfig };
    } catch {
      // Ignore malformed config file
    }
  }

  // Environment variables override file config
  config.openaiApiKey = config.openaiApiKey || process.env.OPENAI_API_KEY;
  config.anthropicApiKey = config.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  config.nvidiaApiKey = config.nvidiaApiKey || process.env.NVIDIA_API_KEY;
  config.omnirouteBaseUrl = config.omnirouteBaseUrl || process.env.OMNIROUTER_BASE_URL;
  config.omnirouteApiKey = config.omnirouteApiKey || process.env.OMNIROUTER_API_KEY;

  // Allow env to override default provider/model
  config.defaultProvider = process.env.MAXI_PROVIDER || config.defaultProvider;
  config.defaultModel = process.env.MAXI_MODEL || config.defaultModel;

  return config;
}

const CONFIG_PATH = resolve(process.cwd(), "maxi.config.json");

export function saveConfigValue<K extends keyof MaxiConfig>(key: K, value: MaxiConfig[K]): void {
  let existing: Partial<MaxiConfig> = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      existing = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<MaxiConfig>;
    } catch {
      // Malformed existing file — overwrite rather than merge garbage into it.
    }
  }
  const updated = { ...existing, [key]: value };
  writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2) + "\n", "utf-8");
}

export function isConfigGitignored(): boolean {
  const gitignorePath = resolve(process.cwd(), ".gitignore");
  if (!existsSync(gitignorePath)) return false;
  try {
    const lines = readFileSync(gitignorePath, "utf-8").split("\n").map((l) => l.trim());
    return lines.includes("maxi.config.json") || lines.includes("/maxi.config.json");
  } catch {
    return false;
  }
}

/**
 * Validate that the config has at least one usable provider.
 * Returns an error message string if invalid, or null if valid.
 */
const LOCAL_PROVIDER_IDS = ["ollama", "lmstudio", "vllm", "llamacpp"];

export function validateConfig(config: MaxiConfig, resolvedProvider?: string): string | null {
  if (resolvedProvider && LOCAL_PROVIDER_IDS.includes(resolvedProvider)) {
    return null;
  }
  const hasOpenAI = !!config.openaiApiKey;
  const hasAnthropic = !!config.anthropicApiKey;
  const hasNVIDIA = !!config.nvidiaApiKey;
  const hasOmniroute = !!config.omnirouteBaseUrl;

  if (!hasOpenAI && !hasAnthropic && !hasNVIDIA && !hasOmniroute) {
    return [
      "No API key configured.",
      "",
      "Set one of the following environment variables:",
      "  OPENAI_API_KEY        - for OpenAI (gpt-4o, etc.)",
      "  ANTHROPIC_API_KEY     - for Anthropic (Claude)",
      "  NVIDIA_API_KEY        - for NVIDIA (Nemotron, Llama, etc.)",
      "  OMNIROUTER_BASE_URL   - for OmniRoute gateway",
      "  OMNIROUTER_API_KEY    - for OmniRoute gateway",
      "",
      "Or create a maxi.config.json file with your credentials.",
    ].join("\n");
  }

  return null;
}
