import { describe, it, expect } from "vitest";
import { loadConfig, validateConfig } from "../src/config.js";
import { resolveStartupProvider } from "../src/providers/local.js";
import { buildRegistry, resolveModel } from "../src/providers/registry.js";
import { buildToolRegistry } from "../src/tools/registry.js";
import { toAiTools } from "../src/tools/ai.js";
import type { MaxiConfig } from "../src/providers/types.js";

describe("config", () => {
  it("loads defaults when nothing is configured", () => {
    const config = loadConfig();
    expect(config.defaultProvider).toBe("openai");
    expect(config.defaultModel).toBe("gpt-4o");
    expect(config.webToolsEnabled).toBe(true);
  });
});

describe("validateConfig", () => {
  it("returns an error when no provider is configured", () => {
    const config: MaxiConfig = { defaultProvider: "openai", defaultModel: "gpt-4o" };
    expect(validateConfig(config)).toContain("No provider configured");
  });

  it("passes when a cloud key is present", () => {
    const config: MaxiConfig = {
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      openaiApiKey: "sk-test",
    };
    expect(validateConfig(config)).toBeNull();
  });

  it("passes when a local provider is configured", () => {
    const config: MaxiConfig = {
      defaultProvider: "ollama",
      defaultModel: "llama3.1",
      providers: {
        ollama: { provider: "ollama", model: "llama3.1", baseURL: "http://localhost:11434/v1" },
      },
    };
    expect(validateConfig(config)).toBeNull();
  });
});

describe("resolveStartupProvider", () => {
  it("resolves anthropic to claude-sonnet-4-5 when the anthropic key is set", async () => {
    const config: MaxiConfig = {
      defaultProvider: "anthropic",
      defaultModel: "gpt-4o",
      anthropicApiKey: "sk-ant-test",
    };
    const resolved = await resolveStartupProvider(config);
    expect(resolved?.provider).toBe("anthropic");
    expect(resolved?.model).toBe("claude-sonnet-4-5");
  });

  it("resolves nvidia to meta/llama-3.1-8b-instruct when the nvidia key is set", async () => {
    const config: MaxiConfig = {
      defaultProvider: "nvidia",
      defaultModel: "gpt-4o",
      nvidiaApiKey: "nv-test",
    };
    const resolved = await resolveStartupProvider(config);
    expect(resolved?.provider).toBe("nvidia");
    expect(resolved?.model).toBe("meta/llama-3.1-8b-instruct");
  });

  it("keeps the configured local model for a local default provider", async () => {
    const config: MaxiConfig = {
      defaultProvider: "ollama",
      defaultModel: "llama3.1",
      providers: {
        ollama: { provider: "ollama", model: "llama3.1", baseURL: "http://localhost:11434/v1" },
      },
    };
    const resolved = await resolveStartupProvider(config);
    expect(resolved?.provider).toBe("ollama");
    expect(resolved?.model).toBe("llama3.1");
  });

  it("returns null when nothing is usable", async () => {
    const original = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      NVIDIA_API_KEY: process.env.NVIDIA_API_KEY,
    };
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.NVIDIA_API_KEY;
    try {
      const config: MaxiConfig = { defaultProvider: "openai", defaultModel: "gpt-4o" };
      const resolved = await resolveStartupProvider(config);
      expect(resolved).toBeNull();
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("tool registry", () => {
  it("builds 18 tools with expected names", () => {
    const config: MaxiConfig = { defaultProvider: "openai", defaultModel: "gpt-4o" };
    const tools = buildToolRegistry(config);
    expect(tools.length).toBe(18);
    const names = tools.map((t) => t.name);
    expect(names).toContain("readFile");
    expect(names).toContain("writeFile");
    expect(names).toContain("bash");
    expect(names).toContain("gitStatus");
    expect(names).toContain("webSearch");
    expect(names).toContain("fetchUrl");
  });
});

describe("toAiTools", () => {
  it("converts maxi tools to an AI SDK v7 ToolSet", async () => {
    const config: MaxiConfig = { defaultProvider: "openai", defaultModel: "gpt-4o" };
    const aiTools = toAiTools(buildToolRegistry(config));
    expect(Object.keys(aiTools).length).toBe(18);

    const readFile = aiTools["readFile"] as unknown as {
      description: string;
      inputSchema: unknown;
      execute: (args: Record<string, unknown>) => Promise<string>;
    };
    expect(readFile).toBeDefined();
    expect(readFile.description).toBeTruthy();
    expect(readFile.inputSchema).toBeDefined();
    expect(typeof readFile.execute).toBe("function");

    const result = await readFile.execute({ path: "__nonexistent__" });
    expect(typeof result).toBe("string");
    expect(result).toContain("Error");
  });
});

describe("registry resolveModel", () => {
  it("resolves anthropic:claude-sonnet-4-5 without throwing", () => {
    const config: MaxiConfig = {
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-5",
      anthropicApiKey: "sk-ant-test",
    };
    const registry = buildRegistry(config);
    expect(() => resolveModel(registry, "anthropic", "claude-sonnet-4-5")).not.toThrow();
  });
});
