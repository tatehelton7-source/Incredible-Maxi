/**
 * Phase 4.2 — Sandboxing guards.
 *
 * Two cheap, platform-independent layers that bound what tools can reach:
 *
 *  1. `createPathGuard` — file tools cannot write outside declared roots.
 *     Paths are resolved against cwd, normalized, and checked with a
 *     trailing-separator-safe prefix comparison (case-insensitive on win32).
 *
 *  2. `sandboxCapability` — reports the effective sandboxing level for this
 *     platform. On bare Windows (no WSL2/container) the level is 'path-only':
 *     path confinement + approval only, never full OS sandboxing. Tier 3
 *     auto-downgrades to ask-on-write in that case (see repl.ts).
 *
 * Real OS-level sandboxing (restricted backends, WSL2/containers) is Phase-10+
 * and intentionally NOT attempted here.
 *
 * This module also owns the *types* and *pure helpers* of the per-step sandbox
 * layer (Phase 4.2 extension):
 *
 *  - `StepIntent` / `ResourceLimits` / `SandboxDenial` / `ExecResult` /
 *    `RunOpts` / `SandboxRunner` — the contract every runner implements.
 *  - `checkConfigGuard` / `partitionWrites` — config-guard classification of
 *    declared write paths. These are PURE and never touch the filesystem, so
 *    they also classify not-yet-existing files (the whole point: never gate on
 *    existence).
 *  - `summarizeDenials` — plain-English per-layer counts for `maxi session
 *    inspect`. Pure.
 *
 * The concrete runners (Docker / WSL+bwrap / unsandboxed) live in
 * `sandbox-runners.ts`; this module only defines the contract and the pure
 * classification helpers.
 */

import { resolve, sep } from "node:path";
import { platform } from "node:os";
import { execFileSync } from "node:child_process";
import { getSandboxRunner } from "./sandbox-runners.js";
import type { SessionEvent } from "../session/store.js";

export interface PathGuard {
  /** Throw a descriptive error if `path` resolves outside every declared root. */
  assertWithinRoots(path: string): void;
}

export type SandboxLevel = "path-only" | "wsl" | "docker" | "none";

export interface SandboxCapability {
  level: SandboxLevel;
  note: string;
}

// ---------------------------------------------------------------------------
// Per-step sandbox contract (Phase 4.2 extension)
// ---------------------------------------------------------------------------

/** Default resource limits applied to a sandboxed step. */
export interface ResourceLimits {
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  timeoutMs: number;
}

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  memoryMb: 512,
  cpus: 1,
  pidsLimit: 256,
  timeoutMs: 60_000,
};

/**
 * What a single step intends to do. The runner scopes the sandbox to this
 * intent: only `declaredWrites` are mounted read-write, network is allowed
 * only when `network.domains` is present, and resource limits are applied.
 */
export interface StepIntent {
  stepId: string;
  declaredWrites: { path: string }[];
  network?: { domains: string[] };
  resourceLimits?: Partial<ResourceLimits>;
}

/** A denial produced by a runner when a step exceeds its declared scope. */
export interface SandboxDenial {
  layer: "path-confinement" | "network-allowlist" | "resource-limit" | "config-guard";
  detail: string;
  /** Snapshot of the step intent at denial time (for audit). */
  scopeSnapshot: string;
}

/** Result of a sandboxed command execution. */
export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  sandboxDenial?: SandboxDenial;
}

/** Options passed to a runner's `exec`. */
export interface RunOpts {
  /** Project root (mounted read-only by default). */
  root: string;
  /** The step intent that scopes this execution. */
  step: StepIntent;
  /** Extra paths mounted read-only (e.g. toolchain caches). */
  extraReadOnlyMounts?: string[];
}

/** A selected sandbox backend. */
export interface SandboxRunner {
  kind: "docker" | "wsl-bwrap" | "unsandboxed";
  description: string;
  exec(cmd: string, opts: RunOpts): Promise<ExecResult>;
}

// ---------------------------------------------------------------------------
// Config-guard classification (pure — never touches the filesystem)
// ---------------------------------------------------------------------------

/**
 * Paths that are "hook-eligible" — i.e. they configure Maxi itself or the
 * project's git hooks, and must never be written by a sandboxed step without
 * explicit approval. Matching is purely pattern-based so it also classifies
 * not-yet-existing files (never gate on existence).
 *
 * NOTE: pattern 1 intentionally matches the `.maxi/hooks` / `.maxi/config`
 * directories AND anything beneath them (`.maxi/hooks/new.sh`), so a step
 * cannot smuggle a hook in by writing a subpath.
 */
export const HOOK_ELIGIBLE_PATTERNS: RegExp[] = [
  /(^|\/)\.maxi\/(config|hooks?)(\.[a-z]+)?(\/.*)?$/i,
  /(^|\/)\.maxi\/agents\/.*\.json$/i,
  /(^|\/)settings(\.local)?\.json$/i,
  /(^|\/)\.git\/hooks\//i,
];

/**
 * True when `relativePath` (a path relative to the project root) is
 * config-guard-eligible and therefore must not be written by a sandboxed step.
 * Pure — does not check existence.
 */
export function checkConfigGuard(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return HOOK_ELIGIBLE_PATTERNS.some((re) => re.test(normalized));
}

/**
 * Partition declared write paths into those allowed by the config guard and
 * those blocked. Blocked paths are simply not mounted read-write by the
 * runner (and a denial is recorded). Pure.
 */
export function partitionWrites(
  paths: string[]
): { allowed: string[]; blocked: string[] } {
  const allowed: string[] = [];
  const blocked: string[] = [];
  for (const p of paths) {
    if (checkConfigGuard(p)) blocked.push(p);
    else allowed.push(p);
  }
  return { allowed, blocked };
}

/**
 * Plain-English summary of sandbox denials, grouped by layer, for
 * `maxi session inspect`. Pure — takes the session events and returns a
 * human-readable string (empty when there are no denials).
 */
export function summarizeDenials(events: readonly SessionEvent[]): string {
  const counts = new Map<string, number>();
  for (const ev of events) {
    if (ev.type === "sandbox-denial") {
      counts.set(ev.layer, (counts.get(ev.layer) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return "";
  const lines = ["Sandbox denials:"];
  for (const [layer, count] of counts) {
    lines.push(`  - ${layer}: ${count}`);
  }
  return lines.join("\n");
}

/** True on win32 when a usable, general-purpose WSL2 distribution is installed. */
function detectWsl(): boolean {
  if (platform() !== "win32") return false;
  try {
    // `wsl.exe -l -q` lists installed distributions. A bare WSL install with no
    // distro reports only the "Windows Subsystem for Linux" placeholder, and
    // `docker-desktop` is Docker's internal VM — neither is a usable Maxi
    // sandbox, so neither counts as WSL.
    const raw = execFileSync("wsl.exe", ["-l", "-q"], {
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    // `wsl.exe` emits UTF-16LE; decode it so distro names match cleanly.
    const out = raw.toString("utf16le");
    const lines = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(
        (l) =>
          l.length > 0 &&
          !/^Windows Subsystem for Linux$/i.test(l) &&
          !/^docker-desktop$/i.test(l)
      );
    return lines.length > 0;
  } catch {
    return false;
  }
}

/**
 * Report the effective sandboxing capability for this platform.
 *
 * When a sandbox runner is active and available, reports its kind.
 * Otherwise falls back to platform detection:
 * - win32 without WSL2 => 'path-only' (path confinement + approval only).
 * - win32 with WSL2   => 'wsl' (full sandboxing available under WSL2).
 * - POSIX             => 'none' (restricted backends are Phase-10+; the
 *   platform itself is not the blocker, so no downgrade note is needed).
 */
export function sandboxCapability(): SandboxCapability {
  const activeRunner = getSandboxRunner();
  if (activeRunner && activeRunner.kind !== "unsandboxed") {
    if (activeRunner.kind === "wsl-bwrap") {
      return { level: "wsl", note: "Sandbox: WSL + bubblewrap active (fs-isolated, no network)." };
    }
    if (activeRunner.kind === "docker") {
      return { level: "docker", note: "Sandbox: Docker active (image configurable)." };
    }
  }

  if (platform() === "win32") {
    if (detectWsl()) {
      return {
        level: "wsl",
        note: "Windows: WSL2 detected — run under WSL2 for full sandboxing.",
      };
    }
    return {
      level: "path-only",
      note: "Windows: path confinement + approval only; run under WSL2/container for full sandboxing.",
    };
  }
  return {
    level: "none",
    note: "POSIX: OS-level sandboxing is Phase-10+; path confinement + approval apply.",
  };
}

/**
 * Build a path guard over the given roots (defaults to [process.cwd()]).
 *
 * The returned `assertWithinRoots` resolves the candidate path against cwd,
 * normalizes it, and checks it is inside at least one root using a
 * trailing-separator-safe prefix comparison. On win32 the comparison is
 * case-insensitive so `C:\Foo` and `c:\foo` are treated as the same root.
 */
export function createPathGuard(roots: string[] = [process.cwd()]): PathGuard {
  const caseInsensitive = platform() === "win32";

  const normalizeRoot = (abs: string): string => {
    // Ensure a trailing separator so `C:\root` does not prefix-match `C:\root2`.
    return abs.endsWith(sep) ? abs : abs + sep;
  };

  const normalizedRoots = roots.map((r) => normalizeRoot(resolve(r)));

  const within = (candidate: string, root: string): boolean => {
    const c = caseInsensitive ? candidate.toLowerCase() : candidate;
    const r = caseInsensitive ? root.toLowerCase() : root;
    return c.startsWith(r);
  };

  return {
    assertWithinRoots(path: string): void {
      const absolute = resolve(path);
      const normalized = normalizeRoot(absolute);
      if (!normalizedRoots.some((root) => within(normalized, root))) {
        throw new Error(
          `Path outside declared writable roots: ${path} (resolved to ${absolute}). ` +
            `Allowed roots: ${roots.join(", ")}`
        );
      }
    },
  };
}
