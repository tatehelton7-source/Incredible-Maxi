import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { MaxiConfig } from "./providers/types.js";
import { DEFAULT_CONFIG } from "./providers/types.js";

const CLAUDE_MD_PATH = resolve(process.cwd(), "maxi.CLAUDE.md");

/**
 * Parse CLAUDE.md file for configuration options.
 * Expected format:
 * ```markdown
 * # Project Configuration
 * 
 * ## Default Provider
 * openai
 * 
 * ## Default Model
 * gpt-4o
 * 
 * ## Available Tools
 * - readFile
 * - writeFile
 * - editFile
 * - bash
 * - listDirectory
 * - glob
 * - grep
 * 
 * ## Project Conventions
 * - Use TypeScript strict mode
 * - Follow existing code style
 * 
 * ## Build Commands
 * - npm run build
 * - npm test
 * ```
 */
export function parseClaudeMd(content: string): Partial<MaxiConfig> {
  const config: Partial<MaxiConfig> = {};
  
  // Parse default provider
  const providerMatch = content.match(/## Default Provider\s*\n\s*(\S+)/i);
  if (providerMatch) {
    config.defaultProvider = providerMatch[1].trim();
  }
  
  // Parse default model
  const modelMatch = content.match(/## Default Model\s*\n\s*(\S+)/i);
  if (modelMatch) {
    config.defaultModel = modelMatch[1].trim();
  }
  
  // Parse available tools
  const toolsMatch = content.match(/## Available Tools\s*\n([\s\S]*?)(?:\n## |\n*$)/i);
  if (toolsMatch) {
    const tools = toolsMatch[1]
      .split("\n")
      .map(line => line.trim().replace(/^[-*]\s*/, ""))
      .filter(line => line.length > 0);
    config.agents = tools; // Store as agents for now
  }
  
  // Parse project conventions
  const conventionsMatch = content.match(/## Project Conventions\s*\n([\s\S]*?)(?:\n## |\n*$)/i);
  if (conventionsMatch) {
    config.systemPrompt = conventionsMatch[1].trim();
  }
  
  // Parse build commands
  const buildMatch = content.match(/## Build Commands\s*\n([\s\S]*?)(?:\n## |\n*$)/i);
  if (buildMatch) {
    // Could store in a custom field or extend MaxiConfig
  }
  
  return config;
}

/**
 * Load Maxi configuration from:
 * 1. Environment variables (highest priority)
 * 2. maxi.CLAUDE.md in project root
 * 3. maxi.config.json in project root
 * 4. Defaults
 */
export function loadConfigWithClaudeMd(): MaxiConfig {
  let config: MaxiConfig = { ...DEFAULT_CONFIG };
  
  // Try loading maxi.CLAUDE.md
  if (existsSync(CLAUDE_MD_PATH)) {
    try {
      const raw = readFileSync(CLAUDE_MD_PATH, "utf-8");
      const claudeConfig = parseClaudeMd(raw);
      config = { ...config, ...claudeConfig };
    } catch {
      // Ignore malformed CLAUDE.md
    }
  }
  
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