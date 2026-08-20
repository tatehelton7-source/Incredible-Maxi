import { createOpenAICompatibleSource } from "./openai-compatible-source.js";

export const lmstudioSource = createOpenAICompatibleSource({
  id: "lmstudio",
  label: "LM Studio",
  defaultBaseURL: "http://localhost:1234/v1",
  getBackendConfig: (config) => config.localBackends?.lmstudio,
});
