import { createProviderRegistry, type LanguageModel } from "ai";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { MaxiConfig } from "./types.js";

/**
 * Build a provider registry from the Maxi config.
 *
 * Supports:
 * - openai (direct)
 * - anthropic (direct)
 * - nvidia (OpenAI-compatible)
 * - ollama (via OLLAMA_HOST or localBackend.baseURL)
 * - lmstudio (via localBackend.baseURL)
 * - vllm (via localBackend.baseURL)
 * - llamacpp (via localBackend.baseURL)
 */
export function buildRegistry(config: MaxiConfig) {
  const providers: Record<string, ReturnType<typeof createOpenAICompatible> | typeof openai | typeof anthropic> = {
    openai,
    anthropic,
    nvidia: createOpenAICompatible({
      name: "nvidia",
      apiKey: config.nvidiaApiKey || process.env.NVIDIA_API_KEY || "",
      baseURL: "https://integrate.api.nvidia.com/v1",
    }),
    // Ollama's OLLAMA_HOST convention is a root URL; its OpenAI-compat
    // endpoint lives under /v1 on that same root.
    ollama: createOpenAICompatible({
      name: "ollama",
      apiKey: "ollama", // unused by Ollama, but the SDK requires a non-empty string
      baseURL: `${(config.localBackends?.ollama?.baseURL || process.env.OLLAMA_HOST || "http://localhost:11434").replace(/\/$/, "")}/v1`,
    }),
    // LM Studio / vLLM / llama.cpp configs store the /v1 base directly.
    lmstudio: createOpenAICompatible({
      name: "lmstudio",
      apiKey: "lmstudio",
      baseURL: config.localBackends?.lmstudio?.baseURL || "http://localhost:1234/v1",
    }),
    vllm: createOpenAICompatible({
      name: "vllm",
      apiKey: "vllm",
      baseURL: config.localBackends?.vllm?.baseURL || "http://localhost:8000/v1",
    }),
    llamacpp: createOpenAICompatible({
      name: "llamacpp",
      apiKey: "llamacpp",
      baseURL: config.localBackends?.llamacpp?.baseURL || "http://localhost:8080/v1",
    }),
  };

  // Register OmniRoute if configured
  const omnirouteUrl = config.omnirouteBaseUrl || process.env.OMNIROUTER_BASE_URL;
  const omnirouteKey = config.omnirouteApiKey || process.env.OMNIROUTER_API_KEY;

  if (omnirouteUrl) {
    providers.omniroute = createOpenAICompatible({
      name: "omniroute",
      apiKey: omnirouteKey || "",
      baseURL: omnirouteUrl,
    });
  }

  // Register any custom providers from config
  if (config.providers) {
    for (const [name, providerConfig] of Object.entries(config.providers)) {
      if (providerConfig.baseURL) {
        providers[name] = createOpenAICompatible({
          name,
          apiKey: providerConfig.apiKey || "",
          baseURL: providerConfig.baseURL,
        });
      }
    }
  }

return createProviderRegistry(providers);
}

/**
 * Resolve a language model from the provider registry.
 *
 * @example
 * const model = resolveModel(registry, { provider: "openai", model: "gpt-4o" });
 * const model = resolveModel(registry, { provider: "omniroute", model: "gpt-4o" });
 */
export function resolveModel(
  registry: ReturnType<typeof buildRegistry>,
  provider: string,
  model: string
): LanguageModel {
  return registry.languageModel(`${provider}:${model}`);
}
