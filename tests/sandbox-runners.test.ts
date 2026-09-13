import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkConfigGuard,
  partitionWrites,
  summarizeDenials,
  type StepIntent,
} from "../src/tools/sandbox.js";
import {
  DockerRunner,
  WslRunner,
  UnsandboxedRunner,
  selectRunner,
  toWslPath,
  defaultStepIntent,
  type SpawnResult,
} from "../src/tools/sandbox-runners.js";
import { resolveTier } from "../src/tools/tiers.js";
import { SessionStore } from "../src/session/store.js";

const okSpawn = (): SpawnResult => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });

function captureSpawn() {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const runCommand = async (bin: string, args: string[]): Promise<SpawnResult> => {
    calls.push({ bin, args });
    return okSpawn();
  };
  return { calls, runCommand };
}

const step = (overrides: Partial<StepIntent> = {}): StepIntent => ({
  stepId: "step-1",
  declaredWrites: [],
  ...overrides,
});

// ---------------------------------------------------------------------------
// Config guard + partitionWrites (pure, no mocking)
// ---------------------------------------------------------------------------

describe("checkConfigGuard / partitionWrites", () => {
  it("blocks hook-eligible paths including not-yet-existing files", () => {
    expect(checkConfigGuard(".maxi/hooks/new.sh")).toBe(true);
    expect(checkConfigGuard(".git/hooks/pre-commit")).toBe(true);
    expect(checkConfigGuard(".maxi/config.json")).toBe(true);
    expect(checkConfigGuard(".maxi/hooks")).toBe(true);
    expect(checkConfigGuard(".maxi/agents/foo.json")).toBe(true);
    expect(checkConfigGuard("settings.json")).toBe(true);
    expect(checkConfigGuard("settings.local.json")).toBe(true);
  });

  it("allows ordinary source paths", () => {
    expect(checkConfigGuard("src/x.ts")).toBe(false);
    expect(checkConfigGuard("tests/foo.test.ts")).toBe(false);
    expect(checkConfigGuard("README.md")).toBe(false);
  });

  it("partitionWrites separates blocked from allowed", () => {
    const { allowed, blocked } = partitionWrites([
      ".maxi/hooks/new.sh",
      ".git/hooks/pre-commit",
      "src/x.ts",
    ]);
    expect(blocked).toEqual([".maxi/hooks/new.sh", ".git/hooks/pre-commit"]);
    expect(allowed).toEqual(["src/x.ts"]);
  });

  it("matches windows-style separators", () => {
    expect(checkConfigGuard(".maxi\\hooks\\new.sh")).toBe(true);
    expect(checkConfigGuard(".git\\hooks\\pre-commit")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// toWslPath
// ---------------------------------------------------------------------------

describe("toWslPath", () => {
  it("maps a Windows drive path to /mnt/<drive>/...", () => {
    expect(toWslPath("C:\\foo\\bar")).toBe("/mnt/c/foo/bar");
    expect(toWslPath("D:/work/proj")).toBe("/mnt/d/work/proj");
  });

  it("passes POSIX paths through unchanged", () => {
    expect(toWslPath("/home/user/proj")).toBe("/home/user/proj");
  });
});

// ---------------------------------------------------------------------------
// DockerRunner arg construction
// ---------------------------------------------------------------------------

describe("DockerRunner", () => {
  it("mounts the root read-only plus one rw mount per allowed declared write", async () => {
    const { calls, runCommand } = captureSpawn();
    const runner = new DockerRunner({ sessionId: "s1", runCommand });
    await runner.exec("npm test", {
      root: "C:\\proj",
      step: step({ declaredWrites: [{ path: "src" }, { path: "tests" }] }),
    });
    const { args } = calls[0]!;
    expect(args).toContain("-v");
    expect(args).toContain("C:/proj:/work:ro");
    expect(args).toContain("C:/proj/src:/work/src:rw");
    expect(args).toContain("C:/proj/tests:/work/tests:rw");
  });

  it("denies network by default and enables bridge with a stderr notice when declared", async () => {
    const { calls, runCommand } = captureSpawn();
    const runner = new DockerRunner({ sessionId: "s1", runCommand });

    await runner.exec("curl x", { root: "C:\\proj", step: step() });
    const denied = calls[0]!.args;
    expect(denied).toContain("--network");
    expect(denied).toContain("none");

    const result = await runner.exec("curl x", {
      root: "C:\\proj",
      step: step({ network: { domains: ["example.com"] } }),
    });
    const bridged = calls[1]!.args;
    expect(bridged).toContain("--network");
    expect(bridged).toContain("bridge");
    expect(result.stderr).toContain("[sandbox] network enabled (bridge mode; egress proxy not yet available)");
  });

  it("applies resource limits and ends with image bash -lc cmd", async () => {
    const { calls, runCommand } = captureSpawn();
    const runner = new DockerRunner({ sessionId: "s1", runCommand });
    await runner.exec("echo hi", { root: "C:\\proj", step: step() });
    const { args } = calls[0]!;
    expect(args).toContain("--memory");
    expect(args).toContain("512m");
    expect(args).toContain("--cpus");
    expect(args).toContain("1");
    expect(args).toContain("--pids-limit");
    expect(args).toContain("256");
    expect(args.slice(-4)).toEqual(["alpine:3", "bash", "-lc", "echo hi"]);
  });

  it("resolves the image from the runtime map when no dockerImage is configured", async () => {
    const { calls, runCommand } = captureSpawn();
    const runner = new DockerRunner({
      sessionId: "s1",
      runCommand,
      detectRuntime: async () => "node-20",
    });
    await runner.exec("npm test", { root: "C:\\proj", step: step() });
    expect(calls[0]!.args).toContain("node:20-slim");
  });

  it("mounts the whole root rw for the adhoc default intent", async () => {
    const { calls, runCommand } = captureSpawn();
    const runner = new DockerRunner({ sessionId: "s1", runCommand });
    await runner.exec("npm test", { root: "C:\\proj", step: defaultStepIntent("C:\\proj") });
    const { args } = calls[0]!;
    expect(args).toContain("C:/proj:/work:rw");
    expect(args).not.toContain("C:/proj:/work:ro");
  });
});

// ---------------------------------------------------------------------------
// WslRunner ro-bind ordering (CORRECTION #2 regression)
// ---------------------------------------------------------------------------

describe("WslRunner", () => {
  it("ro-binds the project root before per-writable binds", async () => {
    const { calls, runCommand } = captureSpawn();
    const runner = new WslRunner({
      sessionId: "s1",
      distro: "Ubuntu",
      runCommand,
    });
    await runner.exec("npm test", {
      root: "C:\\proj",
      step: step({ declaredWrites: [{ path: "src" }] }),
    });
    const { bin, args } = calls[0]!;
    expect(bin).toBe("wsl.exe");
    expect(args[0]).toBe("-d");
    expect(args[1]).toBe("Ubuntu");
    const roIndex = args.indexOf("--ro-bind");
    const bindIndex = args.indexOf("--bind");
    expect(roIndex).toBeGreaterThanOrEqual(0);
    expect(bindIndex).toBeGreaterThan(roIndex);
    expect(args[roIndex + 1]).toBe("/mnt/c/proj");
    expect(args[roIndex + 2]).toBe("/mnt/c/proj");
    expect(args).toContain("--unshare-net");
    expect(args).toContain("--unshare-pid");
    expect(args).toContain("--die-with-parent");
  });

  it("describes itself as filesystem isolation only", () => {
    const runner = new WslRunner({ sessionId: "s1", distro: "Ubuntu" });
    expect(runner.description).toContain("filesystem isolation only");
    expect(runner.description).toContain("no per-invocation network deny");
  });
});

// ---------------------------------------------------------------------------
// UnsandboxedRunner platform shell choice (CORRECTION #1)
// ---------------------------------------------------------------------------

describe("UnsandboxedRunner", () => {
  it("uses cmd /c on win32 and /bin/sh -c elsewhere", async () => {
    const { calls, runCommand } = captureSpawn();
    const runner = new UnsandboxedRunner({ runCommand });
    await runner.exec("echo hi", { root: "C:\\proj", step: step() });
    const { bin, args } = calls[0]!;
    if (process.platform === "win32") {
      expect(bin).toBe("cmd");
      expect(args).toEqual(["/c", "echo hi"]);
    } else {
      expect(bin).toBe("/bin/sh");
      expect(args).toEqual(["-c", "echo hi"]);
    }
  });

  it("states the approval-layer-only posture", () => {
    const runner = new UnsandboxedRunner();
    expect(runner.description).toContain("approval layer only");
  });
});

// ---------------------------------------------------------------------------
// selectRunner preference order (injected availability)
// ---------------------------------------------------------------------------

describe("selectRunner", () => {
  const deps = { sessionId: "s1" };

  it("prefers docker when available", async () => {
    const selected = await selectRunner({
      ...deps,
      probeDocker: async () => true,
      probeWslBwrap: async () => ({ available: true, distro: "Ubuntu" }),
    });
    expect(selected.runner.kind).toBe("docker");
    expect(selected.supportsUnattendedAutonomy).toBe(true);
    expect(selected.statusLine).toBe(
      "Sandbox: Docker container (network denied by default, per-step write scope)"
    );
  });

  it("falls back to wsl+bwrap on win32 when docker is unavailable", async () => {
    const selected = await selectRunner({
      ...deps,
      probeDocker: async () => false,
      probeWslBwrap: async () => ({ available: true, distro: "Ubuntu" }),
    });
    if (process.platform === "win32") {
      expect(selected.runner.kind).toBe("wsl-bwrap");
      expect(selected.statusLine).toBe("Sandbox: WSL + bubblewrap (filesystem isolation only)");
      expect(selected.supportsUnattendedAutonomy).toBe(true);
    } else {
      expect(selected.runner.kind).toBe("unsandboxed");
    }
  });

  it("falls back to unsandboxed with no autonomy when nothing is available", async () => {
    const selected = await selectRunner({
      ...deps,
      probeDocker: async () => false,
      probeWslBwrap: async () => ({ available: false, distro: "" }),
    });
    expect(selected.runner.kind).toBe("unsandboxed");
    expect(selected.supportsUnattendedAutonomy).toBe(false);
    expect(selected.statusLine).toContain("install Docker Desktop");
  });

  it("backend 'off' forces the unsandboxed runner", async () => {
    const selected = await selectRunner({
      ...deps,
      config: { backend: "off" },
      probeDocker: async () => true,
      probeWslBwrap: async () => ({ available: true, distro: "Ubuntu" }),
    });
    expect(selected.runner.kind).toBe("unsandboxed");
    expect(selected.supportsUnattendedAutonomy).toBe(false);
  });

  it("backend 'docker' honors the configured image", async () => {
    const selected = await selectRunner({
      ...deps,
      config: { backend: "docker", dockerImage: "node:20-slim" },
      probeDocker: async () => true,
    });
    expect(selected.runner.kind).toBe("docker");
    const runner = selected.runner as DockerRunner;
    const { calls, runCommand } = captureSpawn();
    const withSeam = new DockerRunner({ sessionId: "s1", runCommand, config: { dockerImage: "node:20-slim" } });
    await withSeam.exec("npm test", { root: "C:\\proj", step: step() });
    expect(calls[0]!.args).toContain("node:20-slim");
    expect(runner.kind).toBe("docker");
  });
});

// ---------------------------------------------------------------------------
// Tier downgrade when sandbox unavailable
// ---------------------------------------------------------------------------

describe("resolveTier sandbox gate", () => {
  it("blocks Tier 3 when no isolation sandbox is available", () => {
    expect(
      resolveTier({ autonomy: { tier: 3 }, features: { tier3: true }, sandboxAvailable: false })
    ).toEqual({ tier: 2, requested: 3, tier3Blocked: true });
  });

  it("allows Tier 3 when the flag and an isolation sandbox are present", () => {
    expect(
      resolveTier({ autonomy: { tier: 3 }, features: { tier3: true }, sandboxAvailable: true })
    ).toEqual({ tier: 3, requested: 3, tier3Blocked: false });
  });

  it("does not gate when sandboxAvailable is omitted (backward compatible)", () => {
    expect(resolveTier({ autonomy: { tier: 3 }, features: { tier3: true } })).toEqual({
      tier: 3,
      requested: 3,
      tier3Blocked: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Denial events go through the SessionStore (no separate audit file)
// ---------------------------------------------------------------------------

describe("sandbox denials via SessionStore", () => {
  let dir: string;
  let store: SessionStore;
  let sessionId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "maxi-sandbox-denial-"));
    store = new SessionStore(dir);
    sessionId = await store.createSession();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("records a config-guard denial as a sandbox-denial event in the session JSONL", async () => {
    const { runCommand } = captureSpawn();
    const runner = new DockerRunner({ sessionId, maxiStore: store, runCommand });
    await runner.exec("touch .maxi/hooks/new.sh", {
      root: "C:\\proj",
      step: step({ declaredWrites: [{ path: ".maxi/hooks/new.sh" }, { path: "src" }] }),
    });
    const events = await store.readAll(sessionId);
    const denials = events.filter((e) => e.type === "sandbox-denial");
    expect(denials).toHaveLength(1);
    const denial = denials[0]!;
    expect(denial).toMatchObject({
      type: "sandbox-denial",
      stepId: "step-1",
      layer: "config-guard",
    });
    expect(denial.detail).toContain(".maxi/hooks/new.sh");
  });

  it("does not write any separate audit file", async () => {
    const { runCommand } = captureSpawn();
    const runner = new DockerRunner({ sessionId, maxiStore: store, runCommand });
    await runner.exec("touch .git/hooks/pre-commit", {
      root: "C:\\proj",
      step: step({ declaredWrites: [{ path: ".git/hooks/pre-commit" }] }),
    });
    const files = readdirSync(dir);
    expect(files).toEqual([`${sessionId}.jsonl`]);
  });

  it("summarizeDenials reports per-layer counts", () => {
    const summary = summarizeDenials([
      {
        seq: 0,
        ts: 1,
        sessionId: "s",
        type: "sandbox-denial",
        stepId: "step-1",
        layer: "config-guard",
        detail: "x",
      },
      {
        seq: 1,
        ts: 2,
        sessionId: "s",
        type: "sandbox-denial",
        stepId: "step-2",
        layer: "config-guard",
        detail: "y",
      },
      {
        seq: 2,
        ts: 3,
        sessionId: "s",
        type: "sandbox-denial",
        stepId: "step-3",
        layer: "network-allowlist",
        detail: "z",
      },
    ]);
    expect(summary).toContain("config-guard: 2");
    expect(summary).toContain("network-allowlist: 1");
  });

  it("summarizeDenials returns empty for a clean session", () => {
    expect(summarizeDenials([])).toBe("");
  });
});