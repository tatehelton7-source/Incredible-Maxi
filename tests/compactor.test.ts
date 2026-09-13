import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LanguageModel } from "ai";

const { generateTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
}));

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
  streamText: (...args: unknown[]) => {
    throw new Error("streamText should not be called in compaction tests");
  },
}));

import {
  estimateTokens,
  stubPass,
  compactHistory,
  type HistoryEntry,
} from "../src/context/compactor.js";
import { Repl } from "../src/repl.js";
import { ContextEngine } from "../src/context/engine.js";

const fakeModel = {
  specificationVersion: "v2",
  provider: "test",
  modelId: "test-model",
  supportedUrls: {},
  doGenerate: async () => ({
    content: [],
    finishReason: "stop",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    warnings: [],
  }),
  doStream: async () => {
    throw new Error("doStream should not be called");
  },
} as unknown as LanguageModel;

function makeEntry(role: "user" | "assistant", content: string): HistoryEntry {
  return { role, content };
}

function makeLongToolEntry(n: number): HistoryEntry {
  return makeEntry("assistant", `tool output ${n}\n` + "x".repeat(1000));
}

function makeShortEntry(role: "user" | "assistant", n: number): HistoryEntry {
  return makeEntry(role, `message ${n}`);
}

beforeEach(() => {
  generateTextMock.mockReset();
  generateTextMock.mockResolvedValue({ text: "Goal: test\nKey decisions: none\nFiles touched: none\nNext steps: done" });
});

describe("estimateTokens", () => {
  it("computes ceil(totalChars/4)", () => {
    const messages = [makeEntry("user", "abcd"), makeEntry("assistant", "efgh")];
    expect(estimateTokens(messages)).toBe(2);
  });

  it("rounds up partial tokens", () => {
    const messages = [makeEntry("user", "abc")];
    expect(estimateTokens(messages)).toBe(1);
  });
});

describe("stubPass", () => {
  it("leaves history unchanged when at or below keepRecentTurns", () => {
    const messages = [makeShortEntry("user", 1), makeShortEntry("assistant", 2)];
    const result = stubPass(messages, 10);
    expect(result).toEqual(messages);
  });

  it("stubs long tool-ish entries older than the recent window", () => {
    const messages = [
      makeLongToolEntry(1),
      makeLongToolEntry(2),
      makeShortEntry("user", 3),
      makeShortEntry("assistant", 4),
    ];
    const result = stubPass(messages, 2);
    expect(result[0]).toEqual(messages[0]);
    expect(result[1].content).toContain("[tool output elided — ");
    expect(result[2]).toEqual(messages[2]);
    expect(result[3]).toEqual(messages[3]);
  });

  it("keeps the first user message verbatim", () => {
    const messages = [
      makeEntry("user", "x".repeat(1000)),
      makeLongToolEntry(1),
      makeShortEntry("user", 2),
      makeShortEntry("assistant", 3),
    ];
    const result = stubPass(messages, 2);
    expect(result[0]).toEqual(messages[0]);
  });

  it("keeps short entries verbatim even when old", () => {
    const messages = [
      makeShortEntry("user", 1),
      makeShortEntry("assistant", 2),
      makeShortEntry("user", 3),
      makeShortEntry("assistant", 4),
    ];
    const result = stubPass(messages, 2);
    expect(result[0]).toEqual(messages[0]);
    expect(result[1]).toEqual(messages[1]);
  });
});

describe("compactHistory", () => {
  it("skips entirely when history is small", async () => {
    const messages = [makeShortEntry("user", 1), makeShortEntry("assistant", 2)];
    const result = await compactHistory(messages, undefined, fakeModel, "sys", 1000);
    expect(result.didCompact).toBe(false);
    expect(result.method).toBe("none");
    expect(result.history).toEqual(messages);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("skips when under the token threshold", async () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      makeShortEntry(i % 2 === 0 ? "user" : "assistant", i)
    );
    const result = await compactHistory(messages, { compactionThreshold: 1_000_000 }, fakeModel, "sys", 1000);
    expect(result.didCompact).toBe(false);
    expect(result.method).toBe("none");
  });

  it("uses the stub pass when it brings tokens under threshold (zero LLM cost)", async () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0 ? makeShortEntry("user", i) : makeLongToolEntry(i)
    );
    const result = await compactHistory(messages, { compactionThreshold: 1000, keepRecentTurns: 4 }, fakeModel, "sys", 1000);
    expect(result.didCompact).toBe(true);
    expect(result.method).toBe("stub");
    expect(result.tokensAfter).toBeLessThanOrEqual(1000);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("falls back to stub-only when the LLM compaction fails", async () => {
    generateTextMock.mockRejectedValue(new Error("model down"));
    const messages = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0 ? makeShortEntry("user", i) : makeLongToolEntry(i)
    );
    const result = await compactHistory(messages, { compactionThreshold: 1, keepRecentTurns: 2 }, fakeModel, "sys", 1000);
    expect(result.didCompact).toBe(true);
    expect(result.method).toBe("stub");
    expect(result.history.some((m) => m.content.includes("[tool output elided"))).toBe(true);
  });

  it("produces a summary entry and preserves the recent window verbatim on LLM pass", async () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0 ? makeShortEntry("user", i) : makeLongToolEntry(i)
    );
    const keepRecent = 4;
    const result = await compactHistory(messages, { compactionThreshold: 1, keepRecentTurns: keepRecent }, fakeModel, "sys", 1000);
    expect(result.didCompact).toBe(true);
    expect(result.method).toBe("llm");
    expect(generateTextMock).toHaveBeenCalledTimes(1);

    const recentWindow = messages.slice(messages.length - keepRecent);
    const compactedRecent = result.history.slice(1);
    expect(compactedRecent).toEqual(recentWindow);

    const summaryEntry = result.history[0];
    expect(summaryEntry.role).toBe("user");
    expect(summaryEntry.content).toContain("<conversation-so-far>");
    expect(summaryEntry.content).toContain("</conversation-so-far>");
    expect(summaryEntry.content).toContain("Goal: test");
  });

  it("passes the frozen system prompt and no tools to the LLM compaction call", async () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0 ? makeShortEntry("user", i) : makeLongToolEntry(i)
    );
    await compactHistory(messages, { compactionThreshold: 1, keepRecentTurns: 2 }, fakeModel, "FROZEN-SYSTEM", 1000);
    const callArgs = generateTextMock.mock.calls[0][0] as {
      system: string;
      tools?: unknown;
      messages: Array<{ role: string; content: string }>;
    };
    expect(callArgs.system).toBe("FROZEN-SYSTEM");
    expect(callArgs.tools).toBeUndefined();
    expect(callArgs.messages[0].role).toBe("user");
    expect(callArgs.messages[0].content).toContain("Summarize this conversation excerpt");
  });
});

describe("Repl integration — compaction in handleChat", () => {
  it("compacts a long session and keeps plan/facts pinned and last message verbatim", async () => {
    const mockContextEngine = new ContextEngine(process.cwd());
    vi.spyOn(mockContextEngine, "getContextForPrompt").mockResolvedValue("test context");
    vi.spyOn(mockContextEngine, "indexCodebase").mockResolvedValue(undefined);
    vi.spyOn(mockContextEngine, "getFileCount").mockReturnValue(0);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const repl = new Repl({
      model: fakeModel,
      contextEngine: mockContextEngine,
      config: {
        defaultProvider: "test",
        defaultModel: "test-model",
        context: { compactionThreshold: 1000, keepRecentTurns: 4 },
      },
    });

    const replAny = repl as unknown as {
      history: HistoryEntry[];
      handleChat: (input: string) => Promise<void>;
      frozenSystemPrompt: string;
    };

    await (repl as unknown as { ensureFrozenPrompt: () => Promise<void> }).ensureFrozenPrompt();

    for (let i = 0; i < 60; i++) {
      replAny.history.push({ role: "user", content: `user turn ${i}` });
      replAny.history.push({ role: "assistant", content: `assistant turn ${i}\n` + "y".repeat(800) });
    }

    const tokensBefore = estimateTokens(replAny.history);
    expect(tokensBefore).toBeGreaterThan(1000);

    await replAny.handleChat("final user message");

    const tokensAfter = estimateTokens(replAny.history);
    expect(tokensAfter).toBeLessThan(1000);

    const last = replAny.history[replAny.history.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toBe("final user message");

    expect(replAny.frozenSystemPrompt).toContain("test context");
  });
});
