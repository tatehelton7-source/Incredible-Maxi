import type { MaxiConfig } from "../providers/types.js";
import type { ModelDiscoveryProvider, ModelInfo, ModelStatus } from "../models/types.js";

function getKey(config: MaxiConfig): string | undefined {
  return config.openaiApiKey || process.env.OPENAI_API_KEY;
}

// OpenAI's /v1/models includes embeddings, TTS, moderation, etc. Filter down
// to chat-capable models so the selector isn't full of noise.
const CHAT_MODEL_PATTERN = /^(gpt-|o1|o3|o4|chatgpt-)/i;
const EXCLUDE_PATTERN = /(embedding|whisper|tts|moderation|dall-e|davinci-002|babbage)/i;

export const openaiSource: ModelDiscoveryProvider = {
  id: "openai",
  label: "OpenAI",
  location: "api",

  async probeStatus(config: MaxiConfig): Promise<ModelStatus> {
    const key = getKey(config);
    if (!key) return "not_configured";
    try {
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(2000),
      });
      return res.ok ? "connected" : "auth_failed";
    } catch {
      return "auth_failed";
    }
  },

  async discoverModels(config: MaxiConfig): Promise<ModelInfo[]> {
    const key = getKey(config);
    if (!key) return [];
    try {
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { data: { id: string }[] };
      return data.data
        .filter((m) => CHAT_MODEL_PATTERN.test(m.id) && !EXCLUDE_PATTERN.test(m.id))
        .map((m) => ({
          id: m.id,
          displayName: m.id,
          provider: "openai",
          location: "api" as const,
          status: "connected" as const,
          capabilities: { tools: true, vision: /gpt-4o|gpt-5|o[1-9]/i.test(m.id), reasoning: /^o[1-9]/i.test(m.id) },
        }));
    } catch {
      return [];
    }
  },
};
