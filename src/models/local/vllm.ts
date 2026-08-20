import { createOpenAICompatibleSource } from "./openai-compatible-source.js";

export const vllmSource = createOpenAICompatibleSource({
  id: "vllm",
  label: "vLLM",
  defaultBaseURL: "http://localhost:8000/v1",
  getBackendConfig: (config) => config.localBackends?.vllm,
});
