import type { MaxiConfig } from "../providers/types.js";
import type { ModelDiscoveryProvider, ModelInfo, ModelStatus } from "../models/types.js";

function getKey(config: MaxiConfig): string | undefined {
  return config.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
}

async function fetchModels(key: string) {
  return fetch("https://api.anthropic.com/v1/models", {
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    signal: AbortSignal.timeout(2000),
  });
}

export const anthropicSource: ModelDiscoveryProvider = {
  id: "anthropic",
  label: "Anthropic",
  location: "api",

  async probeStatus(config: MaxiConfig): Promise<ModelStatus> {
    const key = getKey(config);
    if (!key) return "not_configured";
    try {
      const res = await fetchModels(key);
      return res.ok ? "connected" : "auth_failed";
    } catch {
      return "auth_failed";
    }
  },

  async discoverModels(config: MaxiConfig): Promise<ModelInfo[]> {
    const key = getKey(config);
    if (!key) return [];
    try {
      const res = await fetchModels(key);
      if (!res.ok) return [];
      const data = (await res.json()) as { data: { id: string; display_name?: string }[] };
      return data.data.map((m) => ({
        id: m.id,
        displayName: m.display_name || m.id,
        provider: "anthropic",
        location: "api" as const,
        status: "connected" as const,
        capabilities: { tools: true, vision: true, reasoning: /opus|sonnet/i.test(m.id) },
      }));
    } catch {
      return [];
    }
  },
};
