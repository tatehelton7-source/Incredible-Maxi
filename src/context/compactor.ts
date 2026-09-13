import { generateText } from "ai";
import type { LanguageModel } from "ai";
import type { ContextCompactionConfig } from "../providers/types.js";

export type HistoryEntry = { role: "user" | "assistant"; content: string };

const DEFAULT_THRESHOLD = 60_000;
const DEFAULT_KEEP_RECENT = 10;
const STUB_LENGTH_THRESHOLD = 400;

export function estimateTokens(messages: readonly HistoryEntry[]): number {
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.ceil(totalChars / 4);
}

export function stubPass(
  messages: readonly HistoryEntry[],
  keepRecentTurns: number
): HistoryEntry[] {
  if (messages.length <= keepRecentTurns) return [...messages];
  const cutoff = messages.length - keepRecentTurns;
  return messages.map((m, i) => {
    if (i >= cutoff) return { ...m };
    if (i === 0) return { ...m };
    if (m.content.length <= STUB_LENGTH_THRESHOLD) return { ...m };
    const firstLine = m.content.split("\n")[0] ?? "";
    const shortFirstLine = firstLine.length <= 120 ? firstLine : firstLine.slice(0, 120) + "...";
    return { ...m, content: `[tool output elided — ${m.content.length} chars]\n${shortFirstLine}` };
  });
}

const SUMMARIZE_SYSTEM =
  "You are a conversation summarizer. Produce a terse structured checkpoint.";
const SUMMARIZE_USER_PREFIX =
  "Summarize this conversation excerpt as a structured checkpoint: Goal / Key decisions / Files touched / Next steps. Be terse.\n\n";

export async function llmCompact(
  messages: readonly HistoryEntry[],
  model: LanguageModel,
  frozenPrompt: string,
  timeoutMs: number
): Promise<string | null> {
  const excerpt = messages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n\n");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await generateText({
      model,
      system: frozenPrompt,
      messages: [{ role: "user", content: SUMMARIZE_USER_PREFIX + excerpt }],
      abortSignal: controller.signal,
    });
    return result.text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface CompactResult {
  history: HistoryEntry[];
  didCompact: boolean;
  tokensBefore: number;
  tokensAfter: number;
  method: "none" | "stub" | "llm";
}

export async function compactHistory(
  messages: readonly HistoryEntry[],
  config: ContextCompactionConfig | undefined,
  model: LanguageModel,
  frozenPrompt: string,
  timeoutMs: number
): Promise<CompactResult> {
  const threshold = config?.compactionThreshold ?? DEFAULT_THRESHOLD;
  const keepRecent = config?.keepRecentTurns ?? DEFAULT_KEEP_RECENT;
  const tokensBefore = estimateTokens(messages);

  if (messages.length <= keepRecent || tokensBefore <= threshold) {
    return {
      history: [...messages],
      didCompact: false,
      tokensBefore,
      tokensAfter: tokensBefore,
      method: "none",
    };
  }

  const stubbed = stubPass(messages, keepRecent);
  const tokensAfterStub = estimateTokens(stubbed);
  if (tokensAfterStub <= threshold) {
    return {
      history: stubbed,
      didCompact: true,
      tokensBefore,
      tokensAfter: tokensAfterStub,
      method: "stub",
    };
  }

  const oldWindow = stubbed.slice(0, stubbed.length - keepRecent);
  const recentWindow = stubbed.slice(stubbed.length - keepRecent);

  const summary = await llmCompact(oldWindow, model, frozenPrompt, timeoutMs);
  if (summary === null) {
    return {
      history: stubbed,
      didCompact: true,
      tokensBefore,
      tokensAfter: tokensAfterStub,
      method: "stub",
    };
  }

  const summaryEntry: HistoryEntry = {
    role: "user",
    content: `<conversation-so-far>\n${summary}\n</conversation-so-far>`,
  };
  const compacted = [summaryEntry, ...recentWindow];
  const tokensAfter = estimateTokens(compacted);

  return {
    history: compacted,
    didCompact: true,
    tokensBefore,
    tokensAfter,
    method: "llm",
  };
}
