import type { MaxiConfig } from "../providers/types.js";
import type { ModelInfo, ModelStatus } from "./types.js";
import { getAllSources } from "./discovery.js";

export interface RegistrySnapshot {
  local: ModelInfo[];
  api: ModelInfo[];
  /** Status per source id, including sources that discovered zero models
   *  (e.g. Ollama running with nothing pulled) — the UI needs this to
   *  distinguish "offline" from "online, empty" instead of just omitting the row. */
  sourceStatus: Record<string, ModelStatus>;
  sourceLabels: Record<string, string>;
}

/**
 * Runs every discovery source concurrently and merges results.
 *
 * Uses Promise.allSettled rather than Promise.all deliberately: a single
 * unreachable custom endpoint must never block the whole selector from
 * rendering. Each source's own discoverModels()/probeStatus() are already
 * non-throwing by contract (see ModelDiscoveryProvider), so allSettled here
 * is a second line of defense against a source that violates that contract.
 */
export async function discoverAll(config: MaxiConfig): Promise<RegistrySnapshot> {
  const sources = getAllSources(config);

  const results = await Promise.allSettled(
    sources.map(async (source) => {
      const [models, status] = await Promise.all([
        source.discoverModels(config),
        source.probeStatus(config),
      ]);
      return { source, models, status };
    })
  );

  const local: ModelInfo[] = [];
  const api: ModelInfo[] = [];
  const sourceStatus: Record<string, ModelStatus> = {};
  const sourceLabels: Record<string, string> = {};

  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const { source, models, status } = result.value;
    sourceStatus[source.id] = status;
    sourceLabels[source.id] = source.label;
    (source.location === "local" ? local : api).push(...models);
  }

  return { local, api, sourceStatus, sourceLabels };
}
