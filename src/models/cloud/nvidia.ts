import type { MaxiConfig } from "../../providers/types.js";
import type { ModelDiscoveryProvider, ModelInfo, ModelStatus } from "../types.js";

function getKey(config: MaxiConfig): string | undefined {
  return config.nvidiaApiKey || process.env.NVIDIA_API_KEY;
}

async function fetchModels(key: string) {
  return fetch("https://integrate.api.nvidia.com/v1/models", {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(2000),
  });
}

// Same filter previously hardcoded in repl.ts's /models handler: NVIDIA's
// catalog includes a lot of non-chat models (embeddings, retrievers, etc.)
// this excludes.
function isChatModel(id: string): boolean {
  return id.includes("instruct") || id.includes("chat") || id.includes("nemotron");
}

export const nvidiaSource: ModelDiscoveryProvider = {
  id: "nvidia",
  label: "NVIDIA",
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
      const data = (await res.json()) as { data: { id: string }[] };
      return data.data
        .filter((m) => isChatModel(m.id))
        .map((m) => ({
          id: m.id,
          displayName: m.id,
          provider: "nvidia",
          location: "api" as const,
          status: "connected" as const,
          capabilities: { tools: false, vision: false, reasoning: /nemotron/i.test(m.id) },
        }));
    } catch {
      return [];
    }
  },
};
