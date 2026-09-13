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

/** Steps tracked within a plan-mode workflow. */
export enum PlanStep {
  EXPLORE = "explore",
  DESIGN = "design",
  IMPLEMENT = "implement",
  VERIFY = "verify",
}

/** High-level phases of the plan-mode workflow lifecycle. */
export enum WorkflowPhase {
  IDLE = "idle",
  PLANNING = "planning",
  REVIEW = "review",
  APPROVED = "approved",
  EXECUTION = "execution",
}

export interface SkillsConfig {
  directories: string[];
}

export interface CommandsConfig {
  directories: string[];
}

export interface SpinnerConfig {
  enabled: boolean;
  theme: "dots" | "line" | "bounce" | "clock" | "earth" | "moon" | "pulse" | "rotate" | "wave";
  showToolNames: boolean;
}

/** Configuration for the structural approval/deny layer (Phase 0.2). */
export interface ApprovalConfig {
  /** Defaults to 'always-ask'. */
  mode?: "always-ask" | "plan-then-ask" | "auto-with-gates";
  /** Extra deny patterns (regex strings) merged over the built-in dangerous set. */
  extraDeny?: string[];
  /** Command substrings that never ask (read-only: ls, cat, grep, git status, ...). */
  allowlist?: string[];
}

/** Autonomy tier selection (Phase 3.2). Tiers are presets over ApprovalPolicy. */
export interface AutonomyConfig {
  /** 1 = Assistant, 2 = Supervised, 3 = Autonomous (Phase-4 gated). Defaults to 1. */
  tier?: 1 | 2 | 3;
  /** Per-step tool-failure retry budget (Phase 3.4). Defaults to 3. */
  retryBudget?: number;
}

/** Feature flags (Phase 3.2+). */
export interface FeaturesConfig {
  /** Enable Tier 3 (Autonomous). Requires Phase 4 gates/sandbox/governor. Defaults to false. */
  tier3?: boolean;
}

/** Sandboxing configuration (Phase 4.2). */
export interface SandboxConfig {
  /** Additional writable roots beyond the project root. Defaults to []. */
  writableRoots?: string[];
  /** Network egress control. WSL: filesystem-isolated only (documented). Docker: --network none/bridge. */
  network?: boolean;
  /** Sandbox backend. 'wsl' = WSL2, 'docker' = Docker, 'off' = disabled.
   *  Default on win32: auto-detect wsl→docker→none. Default on POSIX: docker→none. */
  backend?: "wsl" | "docker" | "off";
  /** Docker image for the sandbox container. Default 'alpine:3'. */
  dockerImage?: string;
  /** WSL distribution used by the wsl+bwrap backend. Default: first usable distro. */
  wslDistro?: string;
}

/** Context compaction settings (Phase 7). */
export interface ContextCompactionConfig {
  /** Token-count threshold that triggers compaction. Defaults to 60000. */
  compactionThreshold?: number;
  /** Number of recent turns to preserve verbatim. Defaults to 10. */
  keepRecentTurns?: number;
}

/** Session governor ceilings (Phase 4.3). */
export interface GovernorConfig {
  /** Max unattended wall-clock minutes. Defaults to 30. */
  maxMinutes?: number;
  /** Max tool calls per session. Defaults to 100. */
  maxToolCalls?: number;
  /** Max estimated tokens per session. Defaults to 500_000. */
  maxTokens?: number;
}

/** Configuration for plan mode (read-only planning before execution). */
export interface PlanModeConfig {
  /** Master switch. Defaults to false. */
  enabled?: boolean;
  /** When true, tool calls that write files are blocked (not just discouraged via system prompt). Defaults to false. */
  enforced?: boolean;
  /** Current workflow phase while plan mode is active. */
  phase?: WorkflowPhase;
  /** Steps required before execution may begin. */
  steps?: PlanStep[];
  /** Require explicit user approval before leaving planning. Defaults to true. */
  requireApproval?: boolean;
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
  skills?: SkillsConfig;
  plugins?: PluginConfig[];
  mcpServers?: Record<string, McpServerConfig>;
  systemPrompt?: string;
  /** Plan-mode settings. Disabled by default. */
  planMode?: PlanModeConfig;
  /** Approval/deny layer settings. Defaults to 'always-ask'. */
  approval?: ApprovalConfig;
  /** Autonomy tier selection (Phase 3.2). Tiers are presets over ApprovalPolicy. */
  autonomy?: AutonomyConfig;
  /** Feature flags (Phase 3.2+). */
  features?: FeaturesConfig;
  /** Sandboxing configuration (Phase 4.2). */
  sandbox?: SandboxConfig;
  /** Session governor ceilings (Phase 4.3). */
  governor?: GovernorConfig;
  /** Context compaction settings (Phase 7). */
  context?: ContextCompactionConfig;
  /** Spinner settings. */
  spinner?: SpinnerConfig;
  /** UI theme name. Defaults to "default". */
  theme?: string;
  /** Per-request timeout for LLM streaming calls, in milliseconds. Defaults to 120000. */
  requestTimeoutMs?: number;
}

export const DEFAULT_CONFIG: MaxiConfig = {
  defaultProvider: "openai",
  defaultModel: "gpt-4o",
  planMode: { enabled: false },
  spinner: {
    enabled: true,
    theme: "dots",
    showToolNames: true,
  },
};
