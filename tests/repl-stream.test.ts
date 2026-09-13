import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Repl } from "../src/repl.js";
import { ContextEngine } from "../src/context/engine.js";
import type { LanguageModel } from "ai";

/**
 * Build a LanguageModelV2 mock whose doStream rejects mid-stream.
 * This reproduces the AI SDK v7 lazy-stream quirk: the error surfaces
 * asynchronously via `await result.text` (and triggers `onError`), not
 * during the textStream for-await loop.
 */
function createFailingStreamModel(errorMessage: string): LanguageModel {
  return {
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
      throw new Error(errorMessage);
    },
  } as unknown as LanguageModel;
}

describe("REPL stream error handling", () => {
  let repl: Repl;
  let mockContextEngine: ContextEngine;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockContextEngine = new ContextEngine(process.cwd());
    vi.spyOn(mockContextEngine, "getContextForPrompt").mockResolvedValue("test context");
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stops the spinner, prints the error, and resolves without hanging when doStream throws", async () => {
    const model = createFailingStreamModel("boom mid-stream");
    repl = new Repl({
      model,
      contextEngine: mockContextEngine,
      config: { defaultProvider: "test", defaultModel: "test-model" },
    });

    const spinner = (repl as unknown as { spinner: { isEnabled: () => boolean; stop: () => void } }).spinner;
    const stopSpy = vi.spyOn(spinner, "stop");

    // handleChat must resolve within 5s (proves no lingering async rejection / hang)
    await expect(
      Promise.race([
        (repl as unknown as { handleChat: (input: string) => Promise<void> }).handleChat("hello"),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("handleChat hung for 5s")), 5000)
        ),
      ])
    ).resolves.toBeUndefined();

    // Spinner must be stopped after the error
    expect(stopSpy).toHaveBeenCalled();

    // Error message must be printed to stderr
    expect(errorSpy).toHaveBeenCalled();
    const errorOutput = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(errorOutput).toContain("Error");
    expect(errorOutput).toContain("No output generated");
  });

  it("prints a distinguishable timeout message when the request times out", async () => {
    // A model that never resolves — doStream returns a stream that never emits
    const model = {
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
      doStream: async () => ({
        stream: new ReadableStream({
          start() {
            // never enqueue, never close — hangs forever
          },
        }),
      }),
    } as unknown as LanguageModel;

    repl = new Repl({
      model,
      contextEngine: mockContextEngine,
      config: { defaultProvider: "test", defaultModel: "test-model", requestTimeoutMs: 100 },
    });

    const spinner = (repl as unknown as { spinner: { isEnabled: () => boolean; stop: () => void } }).spinner;
    const stopSpy = vi.spyOn(spinner, "stop");

    await expect(
      Promise.race([
        (repl as unknown as { handleChat: (input: string) => Promise<void> }).handleChat("hello"),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("handleChat hung for 5s")), 5000)
        ),
      ])
    ).resolves.toBeUndefined();

    expect(stopSpy).toHaveBeenCalled();
    const errorOutput = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(errorOutput).toContain("timed out");
    expect(errorOutput).toContain("100ms");
  });
});
