import type { MaxiConfig } from "../providers/types.js";

export type ModelLocation = "local" | "api";

export type ModelStatus =
  | "ready" // local: server running, model available
  | "connected" // api: key present and validated
  | "offline" // local: backend not running
  | "not_configured" // api: no key set
  | "auth_failed"; // api: key present but rejected

export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
}

export interface ModelInfo {
  /** Model id as passed to the provider, e.g. "qwen3:8b", "gpt-4o" */
  id: string;
  /** Human-friendly label for the UI, e.g. "Qwen 3 8B" */
  displayName: string;
  /** Discovery source id, e.g. "ollama", "openai" — matches ModelDiscoveryProvider.id */
  provider: string;
  location: ModelLocation;
  status: ModelStatus;
  /** Local models only. Left undefined rather than faked when the source doesn't report it. */
  parameterSize?: string;
  quantization?: string;
  contextWindow?: number;
  /**
   * Capabilities are largely heuristic for local models (see local/capabilities.ts)
   * and authoritative for cloud models. Consumers should not treat `tools: true`
   * on a local model as a hard guarantee.
   */
  capabilities: ModelCapabilities;
}

/**
 * Implemented once per local runtime or cloud provider. Every method MUST be
 * non-throwing — discovery failures resolve to an empty list / offline status,
 * never a rejected promise, so one dead source can't break the whole registry.
 */
export interface ModelDiscoveryProvider {
  /** Short id, used as ModelInfo.provider and as the registry key, e.g. "ollama" */
  id: string;
  /** Human label for UI section grouping, e.g. "Ollama" */
  label: string;
  location: ModelLocation;
  discoverModels(config: MaxiConfig): Promise<ModelInfo[]>;
  /**
   * Cheap reachability/auth check. Called even when discoverModels() returns
   * zero models, so the UI can distinguish "Ollama running, nothing pulled yet"
   * from "Ollama not running" instead of just omitting the row.
   */
  probeStatus(config: MaxiConfig): Promise<ModelStatus>;
}
