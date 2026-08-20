import type { ModelCapabilities } from "../types.js";

/**
 * Local model servers (Ollama, LM Studio, vLLM, llama.cpp) generally don't
 * self-report tool/vision/reasoning support the way cloud provider APIs do.
 * This is a best-effort heuristic on the model id/name, not a guarantee —
 * callers should present it as approximate (e.g. "≈" not "✓") in the UI.
 */
const KNOWN_PATTERNS: { match: RegExp; caps: Partial<ModelCapabilities> }[] = [
  // Families with known, reliable tool-calling support
  { match: /qwen3|qwen2\.5|llama-?3\.[13]|mistral-nemo|firefunction/i, caps: { tools: true } },
  // Reasoning-focused models — generally weaker/no tool-calling
  { match: /deepseek-r1|qwq|o1-|o3-/i, caps: { reasoning: true, tools: false } },
  // Vision-language variants
  { match: /llava|vision|-vl-|minicpm-v/i, caps: { vision: true } },
];

export function inferCapabilities(modelId: string): ModelCapabilities {
  const base: ModelCapabilities = { tools: false, vision: false, reasoning: false };
  for (const pattern of KNOWN_PATTERNS) {
    if (pattern.match.test(modelId)) {
      Object.assign(base, pattern.caps);
    }
  }
  return base;
}
