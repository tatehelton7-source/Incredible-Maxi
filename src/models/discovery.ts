import type { MaxiConfig } from "../providers/types.js";
import type { ModelDiscoveryProvider } from "./types.js";
import { ollamaSource } from "./local/ollama.js";
import { lmstudioSource } from "./local/lmstudio.js";
import { vllmSource } from "./local/vllm.js";
import { llamacppSource } from "./local/llamacpp.js";
import { openaiSource } from "./cloud/openai.js";
import { anthropicSource } from "./cloud/anthropic.js";
import { nvidiaSource } from "./cloud/nvidia.js";
import { createOpenAICompatibleSource } from "./local/openai-compatible-source.js";

const BUILTIN_SOURCES: ModelDiscoveryProvider[] = [
  ollamaSource,
  lmstudioSource,
  vllmSource,
  llamacppSource,
  openaiSource,
  anthropicSource,
  nvidiaSource,
];

/**
 * Any entry in config.providers with a baseURL (custom OpenAI-compatible
 * endpoints, OmniRoute, etc.) gets discovery for free by reusing the same
 * prober as vLLM/llama.cpp — no new source file needed per custom endpoint.
 */
function buildCustomSources(config: MaxiConfig): ModelDiscoveryProvider[] {
  if (!config.providers) return [];
  return Object.entries(config.providers)
    .filter(([, cfg]) => !!cfg.baseURL)
    .map(([name, cfg]) =>
      createOpenAICompatibleSource({
        id: name,
        label: name,
        defaultBaseURL: cfg.baseURL!,
        getBackendConfig: () => ({ baseURL: cfg.baseURL, enabled: true }),
        getApiKey: () => cfg.apiKey,
      })
    );
}

export function getAllSources(config: MaxiConfig): ModelDiscoveryProvider[] {
  return [...BUILTIN_SOURCES, ...buildCustomSources(config)];
}
