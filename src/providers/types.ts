export interface ProviderConfig {
  /** Provider name: "openai", "anthropic", or "omniroute" */
  provider: string;
  /** Model ID, e.g. "gpt-4o", "claude-sonnet-4-5" */
  model: string;
  /** API key (overrides env var) */
  apiKey?: string;
  /** Base URL for custom endpoints (OmniRoute) */
  baseURL?: string;
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
