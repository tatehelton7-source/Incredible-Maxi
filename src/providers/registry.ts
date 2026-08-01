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
 * - nvidia (direct - OpenAI-compatible)
 * - omniroute (custom OpenAI-compatible endpoint)
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
