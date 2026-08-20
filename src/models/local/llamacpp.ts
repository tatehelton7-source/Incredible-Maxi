import { createOpenAICompatibleSource } from "./openai-compatible-source.js";

export const llamacppSource = createOpenAICompatibleSource({
  id: "llamacpp",
  label: "llama.cpp",
  defaultBaseURL: "http://localhost:8080/v1",
  getBackendConfig: (config) => config.localBackends?.llamacpp,
});
