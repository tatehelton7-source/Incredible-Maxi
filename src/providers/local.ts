import type { MaxiConfig, ProviderConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Known local OpenAI-compatible runtimes
// ---------------------------------------------------------------------------

interface LocalRuntime {
  name: string;
  baseURL: string;
  defaultModel: string;
}

const LOCAL_RUNTIMES: LocalRuntime[] = [
  { name: "ollama",   baseURL: "http://localhost:11434/v1", defaultModel: "llama3.1" },
  { name: "lmstudio", baseURL: "http://localhost:1234/v1",  defaultModel: "local-model" },
  { name: "llamacpp", baseURL: "http://localhost:8080/v1",  defaultModel: "local-model" },
  { name: "vllm",     baseURL: "http://localhost:8000/v1",  defaultModel: "local-model" },
];

const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  openai:    "gpt-4o",
  anthropic: "claude-sonnet-4-5",
  nvidia:    "meta/llama-3.1-8b-instruct",
};

// ---------------------------------------------------------------------------
// Network probe
// ---------------------------------------------------------------------------

async function isReachable(baseURL: string, timeoutMs = 400): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseURL}/models`, { signal: controller.signal });
    return res.ok || res.status === 401;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Inject detected local providers into config.providers
// ---------------------------------------------------------------------------

/**
 * Probes all known local runtimes in parallel and registers any that respond.
 * This uses the EXISTING custom-provider mechanism in registry.ts — no new
 * provider types are needed because buildRegistry already loops over
 * config.providers and wires up anything with a `baseURL`.
 *
 * Mutates config in place. Safe to call multiple times (idempotent).
 */
export async function injectLocalProviders(config: MaxiConfig): Promise<string[]> {
  if (!config.providers) config.providers = {};
  const detected: string[] = [];

  await Promise.all(
    LOCAL_RUNTIMES.map(async (runtime) => {
      // User-created provider with the same name always wins
      if (config.providers![runtime.name]) return;

      const ok = await isReachable(runtime.baseURL);
      if (!ok) return;

      const entry: ProviderConfig = {
        provider: runtime.name,
        model: runtime.defaultModel,
        baseURL: runtime.baseURL,
      };
      config.providers![runtime.name] = entry;
      detected.push(runtime.name);
    })
  );

  return detected;
}

// ---------------------------------------------------------------------------
// Startup provider resolution
// ---------------------------------------------------------------------------

export interface StartupResolution {
  provider: string;
  model: string;
  reason: string;
}

/**
 * Decides which provider / model to use at startup when the user hasn't
 * passed an explicit `-p` flag.
 *
 * Priority:
 *   1. The configured defaultProvider, if it already has credentials
 *      (cloud key set) OR is a reachable local entry.
 *   2. Any local entry in config.providers (free, no key needed).
 *   3. Any cloud provider with an API key (openai / anthropic / nvidia).
 *
 * Returns null when nothing is usable — caller should exit with an error.
 *
 * Call AFTER injectLocalProviders() so local entries are present.
 */
export async function resolveStartupProvider(
  config: MaxiConfig
): Promise<StartupResolution | null> {
  const cloudKeys: Record<string, string | undefined> = {
    openai:    config.openaiApiKey    || process.env.OPENAI_API_KEY,
    anthropic: config.anthropicApiKey || process.env.ANTHROPIC_API_KEY,
    nvidia:    config.nvidiaApiKey    || process.env.NVIDIA_API_KEY,
  };

  const defaultIsCloud  = config.defaultProvider in cloudKeys;
  const defaultHasCloudKey = defaultIsCloud && !!cloudKeys[config.defaultProvider];
  const defaultIsLocal = !!(config.providers?.[config.defaultProvider]?.baseURL);

  if (defaultHasCloudKey || defaultIsLocal) {
    return {
      provider: config.defaultProvider,
      model:    defaultIsLocal
        ? config.defaultModel
        : (PROVIDER_DEFAULT_MODELS[config.defaultProvider] ?? config.defaultModel),
      reason:   defaultIsLocal
        ? "configured provider is running locally"
        : "configured provider has a cloud key",
    };
  }

  // Prefer a local runtime — free, no API key needed.
  const localEntry = Object.entries(config.providers ?? {}).find(
    ([, p]) => !!p.baseURL
  );
  if (localEntry) {
    const [name, def] = localEntry;
    return {
      provider: name,
      model:    def.model,
      reason:   `local ${name} detected`,
    };
  }

  // Last resort: any cloud provider with a key.
  const cloudEntry = Object.entries(cloudKeys).find(([, k]) => !!k);
  if (cloudEntry) {
    const [name] = cloudEntry;
    return {
      provider: name,
      model:    PROVIDER_DEFAULT_MODELS[name] ?? config.defaultModel,
      reason:   `${name} key detected`,
    };
  }

  return null;
}
