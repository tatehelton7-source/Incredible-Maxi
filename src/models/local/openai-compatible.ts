export interface OpenAICompatibleModel {
  id: string;
  owned_by?: string;
}

/**
 * Probes a local OpenAI-compatible server's /v1/models endpoint.
 * Returns null (not []) on any failure so callers can distinguish
 * "server offline / unreachable" from "server up, zero models loaded".
 */
export async function probeOpenAICompatible(
  baseURL: string,
  timeoutMs = 800,
  apiKey?: string
): Promise<OpenAICompatibleModel[] | null> {
  try {
    const res = await fetch(`${baseURL.replace(/\/$/, "")}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: OpenAICompatibleModel[] };
    return data.data ?? [];
  } catch {
    return null;
  }
}
