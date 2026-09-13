import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FactStore,
  addFact,
  removeFact,
  renderFactsSection,
  type Fact,
} from "../src/agent/facts.js";
import { Repl } from "../src/repl.js";
import { ContextEngine } from "../src/context/engine.js";
import type { LanguageModel } from "ai";

const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }));
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: streamTextMock };
});

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "maxi-facts-"));
}

describe("FactStore", () => {
  let dir: string;
  let store: FactStore;

  beforeEach(() => {
    dir = makeTempDir();
    store = new FactStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts empty when no file exists", async () => {
    await store.load();
    expect(store.list()).toHaveLength(0);
  });

  it("adds a fact and persists it to disk", async () => {
    await store.load();
    const { id } = await store.add("Use tabs for indentation", "user-correction", "ses-1");
    expect(id).toBe("fact-1");
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].fact).toBe("Use tabs for indentation");
    expect(store.list()[0].source).toBe("user-correction");
    expect(store.list()[0].sessionId).toBe("ses-1");
    expect(existsSync(join(dir, ".maxi", "facts.json"))).toBe(true);
  });

  it("dedups exact trimmed-lowercase matches, bumping ts and keeping id", async () => {
    await store.load();
    const first = await store.add("Use TABS for indentation", "user-correction");
    const second = await store.add("  use tabs for indentation  ", "user-correction");
    expect(second.dedup).toBe(true);
    expect(second.id).toBe(first.id);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].id).toBe(first.id);
  });

  it("user-correction source wins over inferred on dedup", async () => {
    await store.load();
    await store.add("Use tabs", "inferred");
    const result = await store.add("use tabs", "user-correction");
    expect(result.dedup).toBe(true);
    expect(store.list()[0].source).toBe("user-correction");
  });

  it("persists across restart (load round-trip)", async () => {
    await store.load();
    await store.add("Fact A", "user-correction");
    await store.add("Fact B", "user-correction");

    const store2 = new FactStore(dir);
    await store2.load();
    expect(store2.list()).toHaveLength(2);
    expect(store2.list().map((f) => f.fact)).toEqual(["Fact A", "Fact B"]);
  });

  it("treats a corrupt file as empty and never crashes", async () => {
    const factsPath = join(dir, ".maxi", "facts.json");
    mkdirSync(join(dir, ".maxi"), { recursive: true });
    writeFileSync(factsPath, "{ not valid json !!!", "utf-8");
    await store.load();
    expect(store.list()).toHaveLength(0);
    // Adding after corrupt load still works
    await store.add("Recovered", "user-correction");
    expect(store.list()).toHaveLength(1);
  });

  it("treats a non-array JSON file as empty", async () => {
    const factsPath = join(dir, ".maxi", "facts.json");
    mkdirSync(join(dir, ".maxi"), { recursive: true });
    writeFileSync(factsPath, JSON.stringify({ not: "an array" }), "utf-8");
    await store.load();
    expect(store.list()).toHaveLength(0);
  });

  it("removes a fact by id", async () => {
    await store.load();
    const { id } = await store.add("Remove me", "user-correction");
    const removed = await store.remove(id);
    expect(removed).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  it("returns false when removing a nonexistent id", async () => {
    await store.load();
    const removed = await store.remove("fact-999");
    expect(removed).toBe(false);
  });

  it("caps at 30 facts, dropping oldest first", async () => {
    await store.load();
    for (let i = 0; i < 35; i++) {
      await store.add(`Fact number ${i}`, "user-correction");
    }
    expect(store.list()).toHaveLength(30);
    // Oldest (Fact number 0..4) dropped
    const facts = store.list().map((f) => f.fact);
    expect(facts).not.toContain("Fact number 0");
    expect(facts).toContain("Fact number 34");
  });
});

describe("addFact / removeFact pure core", () => {
  it("addFact returns a new array without mutating input", () => {
    const input: Fact[] = [];
    const result = addFact(input, "hello", "user-correction");
    expect(input).toHaveLength(0);
    expect(result.facts).toHaveLength(1);
  });

  it("removeFact filters by id", () => {
    const facts: Fact[] = [
      { id: "fact-1", fact: "a", source: "user-correction", ts: 1 },
      { id: "fact-2", fact: "b", source: "user-correction", ts: 2 },
    ];
    const result = removeFact(facts, "fact-1");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("fact-2");
  });
});

describe("renderFactsSection", () => {
  it("returns empty string for no facts", () => {
    expect(renderFactsSection([])).toBe("");
  });

  it("renders facts oldest-first with a heading", () => {
    const facts: Fact[] = [
      { id: "fact-1", fact: "older", source: "user-correction", ts: 100 },
      { id: "fact-2", fact: "newer", source: "user-correction", ts: 200 },
    ];
    const section = renderFactsSection(facts);
    expect(section).toContain("## Project facts");
    expect(section).toContain("- older");
    expect(section).toContain("- newer");
    expect(section.indexOf("older")).toBeLessThan(section.indexOf("newer"));
  });

  it("caps total characters at 1200", () => {
    const facts: Fact[] = [];
    for (let i = 0; i < 40; i++) {
      facts.push({
        id: `fact-${i}`,
        fact: "x".repeat(100),
        source: "user-correction",
        ts: i,
      });
    }
    const section = renderFactsSection(facts);
    expect(section.length).toBeLessThanOrEqual(1200 + "## Project facts\n".length);
  });
});

describe("Phase 6 frozen-prefix facts injection", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeRepl(cwd: string): Repl {
    const model = {
      provider: "test",
      modelId: "test-model",
      specificationVersion: "v1",
      defaultObjectGenerationMode: "auto",
      supportsStructuredOutputs: true,
      doGenerate: vi.fn(),
      doStream: vi.fn(),
    } as unknown as LanguageModel;
    const contextEngine = new ContextEngine(cwd);
    vi.spyOn(contextEngine, "getContextForPrompt").mockResolvedValue("project snapshot");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    return new Repl({ model, contextEngine, cwd });
  }

  it("frozen prompt contains facts present at session start", async () => {
    // First session: add a fact
    const repl1 = makeRepl(dir);
    const repl1Internal = repl1 as unknown as {
      factStore: FactStore;
      handleFactsCommand: (i: string) => Promise<void>;
    };
    await repl1Internal.factStore.load();
    await repl1Internal.factStore.add("Always use tabs", "user-correction");

    // Second session: frozen prompt should contain the fact
    const repl2 = makeRepl(dir);
    const repl2Internal = repl2 as unknown as {
      ensureFrozenPrompt: () => Promise<void>;
      frozenSystemPrompt: string;
    };
    await repl2Internal.ensureFrozenPrompt();
    expect(repl2Internal.frozenSystemPrompt).toContain("## Project facts");
    expect(repl2Internal.frozenSystemPrompt).toContain("- Always use tabs");
  });

  it("mid-session fact additions do NOT mutate the frozen prompt but appear in volatile reminder", async () => {
    const systems: string[] = [];
    streamTextMock.mockImplementation((opts: { system?: string }) => {
      systems.push(opts.system ?? "");
      return {
        textStream: (async function* () {
          yield "ok";
        })(),
        text: Promise.resolve("ok"),
      };
    });

    const repl = makeRepl(dir);
    const replInternal = repl as unknown as {
      ensureFrozenPrompt: () => Promise<void>;
      frozenSystemPrompt: string;
      buildVolatileReminder: () => string;
      handleFactsCommand: (i: string) => Promise<void>;
      handleChat: (i: string) => Promise<void>;
    };

    await replInternal.ensureFrozenPrompt();
    const frozenBefore = replInternal.frozenSystemPrompt;
    expect(frozenBefore).not.toContain("## Project facts");

    // Add a fact mid-session
    await replInternal.handleFactsCommand("/fact add mid-session fact");

    // Frozen prompt unchanged
    expect(replInternal.frozenSystemPrompt).toBe(frozenBefore);
    expect(replInternal.frozenSystemPrompt).not.toContain("mid-session fact");

    // Volatile reminder contains it
    const reminder = replInternal.buildVolatileReminder();
    expect(reminder).toContain("mid-session fact");
  });
});
