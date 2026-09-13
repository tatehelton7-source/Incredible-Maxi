import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archmapPath,
  readArchMap,
  updateArchMap,
  validateArchMap,
  renderArchMapSection,
} from "../src/agent/archmap.js";
import { TOOL_CATEGORIES, evaluateApproval, type ApprovalPolicy } from "../src/tools/approval.js";
import { Repl } from "../src/repl.js";
import { ContextEngine } from "../src/context/engine.js";
import type { LanguageModel } from "ai";

const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }));
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: streamTextMock };
});

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "maxi-archmap-"));
}

describe("validateArchMap", () => {
  it("accepts valid markdown starting with '# '", () => {
    expect(validateArchMap("# My Project\n\nSome content")).toBeNull();
  });

  it("rejects content whose first line does not start with '# '", () => {
    const err = validateArchMap("no heading here\ncontent");
    expect(err).not.toBeNull();
    expect(err).toContain("first line must start with '# '");
  });

  it("rejects content over 200 lines", () => {
    const lines = ["# Title"];
    for (let i = 0; i < 205; i++) lines.push(`line ${i}`);
    const err = validateArchMap(lines.join("\n"));
    expect(err).not.toBeNull();
    expect(err).toContain("200 lines");
  });

  it("accepts exactly 200 lines", () => {
    const lines = ["# Title"];
    for (let i = 0; i < 199; i++) lines.push(`line ${i}`);
    expect(validateArchMap(lines.join("\n"))).toBeNull();
  });
});

describe("updateArchMap / readArchMap", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a valid architecture map and reads it back", async () => {
    const content = "# My Project\n\n## Overview\nThis is the map.";
    const result = await updateArchMap(dir, content);
    expect(result.ok).toBe(true);
    expect(existsSync(archmapPath(dir))).toBe(true);
    const read = await readArchMap(dir);
    expect(read).toBe(content);
  });

  it("rejects over-200-line content and does not write", async () => {
    const lines = ["# Title"];
    for (let i = 0; i < 205; i++) lines.push(`line ${i}`);
    const result = await updateArchMap(dir, lines.join("\n"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("200 lines");
    expect(existsSync(archmapPath(dir))).toBe(false);
  });

  it("rejects missing '# ' heading and does not write", async () => {
    const result = await updateArchMap(dir, "no heading");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("first line must start with '# '");
    expect(existsSync(archmapPath(dir))).toBe(false);
  });

  it("readArchMap returns null when file does not exist", async () => {
    expect(await readArchMap(dir)).toBeNull();
  });
});

describe("renderArchMapSection", () => {
  it("returns empty string for null content", () => {
    expect(renderArchMapSection(null)).toBe("");
  });

  it("renders content under a heading", () => {
    const section = renderArchMapSection("# My Project\ncontent");
    expect(section).toContain("## Architecture map");
    expect(section).toContain("# My Project");
  });

  it("truncates content over 4000 chars", () => {
    const content = "# Title\n" + "x".repeat(5000);
    const section = renderArchMapSection(content);
    expect(section.length).toBeLessThanOrEqual(4000 + "## Architecture map\n<!-- truncated -->\n".length);
    expect(section).toContain("truncated");
  });
});

describe("architecture_update tool", () => {
  it("is present in the tool map", () => {
    const model = {
      provider: "test",
      modelId: "test-model",
      specificationVersion: "v1",
      defaultObjectGenerationMode: "auto",
      supportsStructuredOutputs: true,
      doGenerate: vi.fn(),
      doStream: vi.fn(),
    } as unknown as LanguageModel;
    const contextEngine = new ContextEngine(process.cwd());
    vi.spyOn(contextEngine, "getContextForPrompt").mockResolvedValue("ctx");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const repl = new Repl({ model, contextEngine });
    const tools = (repl as unknown as {
      getTools: () => Record<string, { execute: (args: Record<string, unknown>) => Promise<string> }>;
    }).getTools();
    expect(tools["architecture_update"]).toBeDefined();
  });

  it("is gated as file-write in TOOL_CATEGORIES", () => {
    expect(TOOL_CATEGORIES["architecture_update"]).toBe("file-write");
  });

  it("evaluateApproval returns 'ask' for architecture_update under tier-1 always-ask policy", () => {
    const policy: ApprovalPolicy = {
      mode: "always-ask",
      denyPatterns: [],
      allowlist: [],
      requireApprovalFor: ["file-write"],
    };
    const result = evaluateApproval(
      { toolName: "architecture_update", args: { content: "# X" } },
      policy
    );
    expect(result.decision).toBe("ask");
  });
});
