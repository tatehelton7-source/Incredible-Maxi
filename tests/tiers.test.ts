import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Repl } from "../src/repl.js";
import { ContextEngine } from "../src/context/engine.js";
import {
  tierToPolicy,
  resolveTier,
  resolveApprovalPolicy,
  type AutonomyTier,
} from "../src/tools/tiers.js";
import { evaluateApproval, type ApprovalPolicy } from "../src/tools/approval.js";
import type { LanguageModel } from "ai";

const createMockModel = (): LanguageModel =>
  ({
    provider: "test",
    modelId: "test-model",
    specificationVersion: "v2",
    supportedUrls: {},
    doGenerate: async () => ({
      content: [],
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      warnings: [],
    }),
    doStream: async () => {
      throw new Error("not used");
    },
  }) as unknown as LanguageModel;

// ---------------------------------------------------------------------------
// tier → policy mapping table.
// ---------------------------------------------------------------------------

describe("tierToPolicy mapping table", () => {
  it("maps Tier 1 to always-ask", () => {
    expect(tierToPolicy(1)).toEqual({ mode: "always-ask" });
  });

  it("maps Tier 2 to plan-then-ask with git-push/network/file-write gated", () => {
    expect(tierToPolicy(2)).toEqual({
      mode: "plan-then-ask",
      requireApprovalFor: ["git-push", "network", "file-write"],
    });
  });

  it("maps Tier 3 to auto-with-gates with no gated categories", () => {
    expect(tierToPolicy(3)).toEqual({ mode: "auto-with-gates", requireApprovalFor: [] });
  });

  it("Tier 2 asks for file-write but allows shell", () => {
    const policy = tierToPolicy(2);
    expect(evaluateApproval({ toolName: "writeFile", args: { path: "src/a.ts" } }, policy).decision).toBe("ask");
    expect(evaluateApproval({ toolName: "bash", args: { command: "npm test" } }, policy).decision).toBe("allow");
  });

  it("Tier 1 asks for shell", () => {
    const policy = tierToPolicy(1);
    expect(evaluateApproval({ toolName: "bash", args: { command: "npm test" } }, policy).decision).toBe("ask");
  });

  it("Tier 3 allows shell and file-write", () => {
    const policy = tierToPolicy(3);
    expect(evaluateApproval({ toolName: "bash", args: { command: "npm test" } }, policy).decision).toBe("allow");
    expect(evaluateApproval({ toolName: "writeFile", args: { path: "src/a.ts" } }, policy).decision).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// resolveTier — Phase-4 gating.
// ---------------------------------------------------------------------------

describe("resolveTier", () => {
  it("defaults to Tier 1 when no tier is configured", () => {
    expect(resolveTier({})).toEqual({ tier: 1, requested: 1, tier3Blocked: false });
  });

  it("resolves Tier 1 and Tier 2 directly", () => {
    expect(resolveTier({ autonomy: { tier: 1 } })).toEqual({ tier: 1, requested: 1, tier3Blocked: false });
    expect(resolveTier({ autonomy: { tier: 2 } })).toEqual({ tier: 2, requested: 2, tier3Blocked: false });
  });

  it("blocks Tier 3 without the feature flag, falling back to Tier 2", () => {
    expect(resolveTier({ autonomy: { tier: 3 } })).toEqual({ tier: 2, requested: 3, tier3Blocked: true });
  });

  it("allows Tier 3 when the feature flag is set", () => {
    expect(resolveTier({ autonomy: { tier: 3 }, features: { tier3: true } })).toEqual({
      tier: 3,
      requested: 3,
      tier3Blocked: false,
    });
  });
});

// ---------------------------------------------------------------------------
// resolveApprovalPolicy — config composition.
// ---------------------------------------------------------------------------

describe("resolveApprovalPolicy", () => {
  it("is backward compatible: no tier → mode from approval.mode or always-ask", () => {
    expect(resolveApprovalPolicy({ defaultProvider: "t", defaultModel: "m" }).mode).toBe("always-ask");
    expect(
      resolveApprovalPolicy({ defaultProvider: "t", defaultModel: "m", approval: { mode: "auto-with-gates" } }).mode
    ).toBe("auto-with-gates");
  });

  it("applies the tier preset when autonomy.tier is set", () => {
    const policy = resolveApprovalPolicy({ defaultProvider: "t", defaultModel: "m", autonomy: { tier: 2 } });
    expect(policy.mode).toBe("plan-then-ask");
    expect(policy.requireApprovalFor).toEqual(["git-push", "network", "file-write"]);
  });

  it("explicit approval.mode overrides the tier preset", () => {
    const policy = resolveApprovalPolicy({
      defaultProvider: "t",
      defaultModel: "m",
      autonomy: { tier: 2 },
      approval: { mode: "always-ask" },
    });
    expect(policy.mode).toBe("always-ask");
  });

  it("explicit approval.allowlist overrides the tier preset allowlist", () => {
    const policy = resolveApprovalPolicy({
      defaultProvider: "t",
      defaultModel: "m",
      autonomy: { tier: 1 },
      approval: { allowlist: ["ls"] },
    });
    expect(policy.allowlist).toEqual(["ls"]);
  });

  it("explicit approval.extraDeny appends to the tier preset deny patterns", () => {
    const policy = resolveApprovalPolicy({
      defaultProvider: "t",
      defaultModel: "m",
      autonomy: { tier: 2 },
      approval: { extraDeny: ["custom-danger"] },
    });
    expect(evaluateApproval({ toolName: "bash", args: { command: "custom-danger" } }, policy).decision).toBe("deny");
  });

  it("blocked Tier 3 resolves to the Tier 2 preset", () => {
    const policy = resolveApprovalPolicy({ defaultProvider: "t", defaultModel: "m", autonomy: { tier: 3 } });
    expect(policy.mode).toBe("plan-then-ask");
    expect(policy.requireApprovalFor).toEqual(["git-push", "network", "file-write"]);
  });

  it("Tier 3 with the feature flag resolves to auto-with-gates", () => {
    const policy = resolveApprovalPolicy({
      defaultProvider: "t",
      defaultModel: "m",
      autonomy: { tier: 3 },
      features: { tier3: true },
    });
    expect(policy.mode).toBe("auto-with-gates");
    expect(policy.requireApprovalFor).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Repl-level: /tier live switch + warning-once.
// ---------------------------------------------------------------------------

describe("repl /tier command", () => {
  let repl: Repl;
  let mockContextEngine: ContextEngine;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockContextEngine = new ContextEngine(process.cwd());
    vi.spyOn(mockContextEngine, "getContextForPrompt").mockResolvedValue("test context");
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeRepl = (config?: Record<string, unknown>): Repl =>
    new Repl({
      model: createMockModel(),
      contextEngine: mockContextEngine,
      config: { defaultProvider: "test", defaultModel: "test-model", ...config },
    });

  const tierCommand = (r: Repl, arg: string): void =>
    (r as unknown as { handleTierCommand: (a: string) => void }).handleTierCommand(arg);

  const currentPolicy = (r: Repl): ApprovalPolicy =>
    (r as unknown as { approvalPolicy: ApprovalPolicy }).approvalPolicy;

  it("starts at the configured tier's policy", () => {
    repl = makeRepl({ autonomy: { tier: 2 } });
    expect(currentPolicy(repl).mode).toBe("plan-then-ask");
  });

  it("defaults to Tier 1 policy when no tier is configured", () => {
    repl = makeRepl();
    expect(currentPolicy(repl).mode).toBe("always-ask");
  });

  it("switches the live policy when /tier 2 is issued", () => {
    repl = makeRepl();
    tierCommand(repl, "2");
    expect(currentPolicy(repl).mode).toBe("plan-then-ask");
    expect(currentPolicy(repl).requireApprovalFor).toEqual(["git-push", "network", "file-write"]);
  });

  it("switches back to Tier 1 when /tier 1 is issued", () => {
    repl = makeRepl({ autonomy: { tier: 2 } });
    tierCommand(repl, "1");
    expect(currentPolicy(repl).mode).toBe("always-ask");
  });

  it("falls back to Tier 2 and prints the warning exactly once per session", () => {
    repl = makeRepl();
    tierCommand(repl, "3");
    tierCommand(repl, "3");
    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    const warning = "Tier 3 requires Phase 4 (gates/sandbox/governor) — falling back to Tier 2";
    expect(output.split(warning).length - 1).toBe(1);
    expect(currentPolicy(repl).mode).toBe("plan-then-ask");
  });

  it("does not print the warning when Tier 3 is enabled via the feature flag", () => {
    repl = makeRepl({ features: { tier3: true } });
    tierCommand(repl, "3");
    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).not.toContain("falling back to Tier 2");
    expect(currentPolicy(repl).mode).toBe("auto-with-gates");
  });

  it("rejects an invalid tier argument", () => {
    repl = makeRepl();
    tierCommand(repl, "9");
    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Invalid tier");
    expect(currentPolicy(repl).mode).toBe("always-ask");
  });
});
