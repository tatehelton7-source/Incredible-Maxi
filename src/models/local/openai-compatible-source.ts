import type { MaxiConfig, LocalBackendConfig } from "../../providers/types.js";
import type { ModelDiscoveryProvider, ModelInfo, ModelStatus } from "../types.js";
import { probeOpenAICompatible } from "./openai-compatible.js";
import { inferCapabilities } from "./capabilities.js";

interface Options {
  id: string;
  label: string;
  defaultBaseURL: string;
  /** Reads this backend's config block, e.g. config.localBackends?.vllm */
  getBackendConfig: (config: MaxiConfig) => LocalBackendConfig | undefined;
  /** Optional, for authenticated custom endpoints (local runtimes usually don't need this). */
  getApiKey?: (config: MaxiConfig) => string | undefined;
}

/**
 * Builds a ModelDiscoveryProvider for any local runtime that exposes a
 * plain OpenAI-compatible /v1/models endpoint (LM Studio, vLLM, llama.cpp).
 *
 * Deliberately does NOT fabricate parameterSize/quantization — those servers'
 * /v1/models responses are typically just {id, object, owned_by}, unlike
 * Ollama's native /api/tags. Leaving those fields undefined lets the UI omit
 * the line rather than render "undefined · undefined".
 */
export function createOpenAICompatibleSource(opts: Options): ModelDiscoveryProvider {
  function baseUrl(config: MaxiConfig): string {
    return opts.getBackendConfig(config)?.baseURL || opts.defaultBaseURL;
  }

  function isEnabled(config: MaxiConfig): boolean {
    return opts.getBackendConfig(config)?.enabled !== false;
  }

  return {
    id: opts.id,
    label: opts.label,
    location: "local",

    async probeStatus(config: MaxiConfig): Promise<ModelStatus> {
      if (!isEnabled(config)) return "offline";
      const models = await probeOpenAICompatible(baseUrl(config), 800, opts.getApiKey?.(config));
      return models !== null ? "ready" : "offline";
    },

    async discoverModels(config: MaxiConfig): Promise<ModelInfo[]> {
      if (!isEnabled(config)) return [];
      const models = await probeOpenAICompatible(baseUrl(config), 800, opts.getApiKey?.(config));
      if (!models) return [];

      return models.map((m) => ({
        id: m.id,
        displayName: m.id,
        provider: opts.id,
        location: "local" as const,
        status: "ready" as const,
        capabilities: inferCapabilities(m.id),
      }));
    },
  };
}
