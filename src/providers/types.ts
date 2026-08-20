export interface ProviderConfig {
  /** Provider name: "openai", "anthropic", or "omniroute" */
  provider: string;
  /** Model ID, e.g. "gpt-4o", "claude-sonnet-4-5" */
  model: string;
  /** API key (overrides env var) */
  apiKey?: string;
  /** Base URL for custom endpoints */
  baseURL?: string;
}

export interface LocalBackendConfig {
  baseURL?: string;
  enabled?: boolean;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface PluginConfig {
  type: "ts" | "wasm" | "subprocess";
  path: string;
}

export interface MaxiConfig {
  defaultProvider: string;
  defaultModel: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  nvidiaApiKey?: string;
  /** Ports/URLs for local model runtimes probed by the model discovery layer. */
  localBackends?: {
    ollama?: LocalBackendConfig;
    lmstudio?: LocalBackendConfig;
    vllm?: LocalBackendConfig;
    llamacpp?: LocalBackendConfig;
  };
  /** Show the full interactive model selector on every interactive launch. Defaults to true on first run. */
  startupModelSelector?: boolean;
  /** Persisted last-used {provider, model}, used for the "continue" quick-start screen. */
  lastUsedModel?: { provider: string; model: string };
  /** API key for Tavily web search (optional) */
  tavilyApiKey?: string;
  /** GitHub token for repository import (optional) */
  githubToken?: string;
  /** Whether web tools are enabled. Defaults to true. */
  webToolsEnabled?: boolean;
  omnirouteBaseUrl?: string;
  omnirouteApiKey?: string;
  providers?: Record<string, ProviderConfig>;
  agents?: string[];
  skills?: string[];
  plugins?: PluginConfig[];
  mcpServers?: Record<string, McpServerConfig>;
  systemPrompt?: string;
}

export const DEFAULT_CONFIG: MaxiConfig = {
  defaultProvider: "openai",
  defaultModel: "gpt-4o",
};
