import type { MaxiConfig } from "../../providers/types.js";
import type { ModelDiscoveryProvider, ModelInfo, ModelStatus } from "../types.js";
import { inferCapabilities } from "./capabilities.js";

function baseUrl(config: MaxiConfig): string {
  return (
    config.localBackends?.ollama?.baseURL ||
    process.env.OLLAMA_HOST ||
    "http://localhost:11434"
  );
}

function isEnabled(config: MaxiConfig): boolean {
  return config.localBackends?.ollama?.enabled !== false;
}

function humanize(name: string): string {
  // "qwen3:8b" -> "Qwen3 8b" ; strip the tag separator, title-case the family
  const [family, tag] = name.split(":");
  const pretty = family
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return tag ? `${pretty} ${tag}` : pretty;
}

interface OllamaTagsResponse {
  models: {
    name: string;
    details?: { parameter_size?: string; quantization_level?: string };
  }[];
}

async function fetchTags(config: MaxiConfig): Promise<OllamaTagsResponse | null> {
  try {
    const res = await fetch(`${baseUrl(config)}/api/tags`, {
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) return null;
    return (await res.json()) as OllamaTagsResponse;
  } catch {
    return null;
  }
}

export const ollamaSource: ModelDiscoveryProvider = {
  id: "ollama",
  label: "Ollama",
  location: "local",

  async probeStatus(config: MaxiConfig): Promise<ModelStatus> {
    if (!isEnabled(config)) return "offline";
    const data = await fetchTags(config);
    return data ? "ready" : "offline";
  },

  async discoverModels(config: MaxiConfig): Promise<ModelInfo[]> {
    if (!isEnabled(config)) return [];
    const data = await fetchTags(config);
    if (!data) return [];

    return data.models.map((m) => ({
      id: m.name,
      displayName: humanize(m.name),
      provider: "ollama",
      location: "local" as const,
      status: "ready" as const,
      parameterSize: m.details?.parameter_size,
      quantization: m.details?.quantization_level,
      capabilities: inferCapabilities(m.name),
    }));
  },
};
