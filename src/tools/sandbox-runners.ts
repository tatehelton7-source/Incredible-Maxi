/**
 * Phase 4.2 — Sandbox runners.
 *
 * Concrete backends for the per-step sandbox contract defined in `sandbox.ts`:
 *
 *  - `DockerRunner` — full isolation: read-only project root, one read-write
 *    mount per declared write, `--network none` by default, resource limits.
 *  - `WslRunner` — WSL2 + bubblewrap: filesystem isolation only (no
 *    per-invocation network deny — documented honestly).
 *  - `UnsandboxedRunner` — no OS sandbox; the approval layer is the only
 *    guard. Used when no isolation backend is available or `backend: 'off'`.
 *
 * `selectRunner` probes docker → (win32 only) wsl+bwrap → unsandboxed, each
 * probe with a 5s timeout. Probes are injectable for tests (CI must not
 * require docker or wsl).
 *
 * Denials (config-guard blocked writes) are recorded through the session
 * store's `append` — the session JSONL is the audit log; no separate file.
 */

import { spawn } from "node:child_process";
import { platform } from "node:os";
import { join } from "node:path";
import { scrubEnv } from "./env.js";
import {
  DEFAULT_RESOURCE_LIMITS,
  partitionWrites,
  type ExecResult,
  type RunOpts,
  type SandboxDenial,
  type SandboxRunner,
  type StepIntent,
} from "./sandbox.js";
import type { SessionStore } from "../session/store.js";
import type { SandboxConfig } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Shared spawn helper
// ---------------------------------------------------------------------------

export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Spawn `bin` with `args`, kill after `timeoutMs`, and collect output.
 * `encoding` defaults to utf8; pass "utf16le" for `wsl.exe -l -q` output.
 */
export function runWithTimeout(
  bin: string,
  args: string[],
  timeoutMs: number,
  cwd?: string,
  env?: NodeJS.ProcessEnv,
  encoding: BufferEncoding = "utf8"
): Promise<SpawnResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: null,
        stdout: Buffer.concat(stdoutChunks).toString(encoding),
        stderr: Buffer.concat(stderrChunks).toString(encoding) || err.message,
        timedOut,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks).toString(encoding),
        stderr: Buffer.concat(stderrChunks).toString(encoding),
        timedOut,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Module-level runner state
// ---------------------------------------------------------------------------

let activeRunner: SandboxRunner | null = null;
let stepIntentProvider: (() => StepIntent | null) | null = null;

/**
 * Install the active runner and the provider that yields the current step's
 * intent. `getStepIntent` returns null when no plan step is active; callers
 * then fall back to `defaultStepIntent`.
 */
export function setSandboxRunner(
  runner: SandboxRunner | null,
  intentProvider: (() => StepIntent | null) | null = null
): void {
  activeRunner = runner;
  stepIntentProvider = intentProvider;
}

export function getSandboxRunner(): SandboxRunner | null {
  return activeRunner;
}

export function getCurrentStepIntent(): StepIntent | null {
  return stepIntentProvider ? stepIntentProvider() : null;
}

/** Default intent when no plan step is active: the whole project root is writable. */
export function defaultStepIntent(): StepIntent {
  return { stepId: "adhoc", declaredWrites: [{ path: "." }] };
}

// ---------------------------------------------------------------------------
// Shared runner deps + denial recording
// ---------------------------------------------------------------------------

export interface RunnerDeps {
  sessionId: string;
  sessionLog?: (line: string) => void;
  detectRuntime?: (root: string) => Promise<string>;
  maxiStore?: SessionStore;
  config?: SandboxConfig;
  /** Test seam: override the spawn helper (CI must not require docker/wsl). */
  runCommand?: typeof runWithTimeout;
}

async function recordDenial(
  deps: Pick<RunnerDeps, "sessionId" | "sessionLog" | "maxiStore">,
  layer: SandboxDenial["layer"],
  detail: string,
  step: StepIntent
): Promise<void> {
  deps.sessionLog?.(`[sandbox] denial (${layer}): ${detail}`);
  if (!deps.maxiStore) return;
  await deps.maxiStore.append(deps.sessionId, {
    type: "sandbox-denial",
    stepId: step.stepId,
    layer,
    detail,
  });
}

// ---------------------------------------------------------------------------
// Docker runner
// ---------------------------------------------------------------------------

const RUNTIME_IMAGES: Record<string, string> = {
  "node-20": "node:20-slim",
  "python-3.12": "python:3.12-slim",
};

async function resolveDockerImage(
  detectRuntime: ((root: string) => Promise<string>) | undefined,
  dockerImage: string | undefined,
  root: string
): Promise<string> {
  if (dockerImage) return dockerImage;
  const runtime = detectRuntime ? await detectRuntime(root) : "";
  return RUNTIME_IMAGES[runtime] ?? "alpine:3";
}

function toDockerPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Full-isolation runner via `docker run`. The project root is mounted
 * read-only at /work; each config-guard-allowed declared write gets its own
 * read-write mount. Network is `--network none` unless the step declares
 * `network.domains`, in which case bridge is used and a stderr notice is
 * printed (egress proxy not yet available).
 */
export class DockerRunner implements SandboxRunner {
  readonly kind = "docker" as const;
  readonly description = "Docker container (network denied by default, per-step write scope)";

  private readonly deps: RunnerDeps;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  async exec(cmd: string, opts: RunOpts): Promise<ExecResult> {
    const { allowed, blocked } = partitionWrites(opts.step.declaredWrites.map((w) => w.path));
    for (const p of blocked) {
      await recordDenial(this.deps, "config-guard", `Write to "${p}" blocked by config guard`, opts.step);
    }
    const limits = { ...DEFAULT_RESOURCE_LIMITS, ...opts.step.resourceLimits };
    const image = await resolveDockerImage(
      this.deps.detectRuntime,
      this.deps.config?.dockerImage,
      opts.root
    );

    const rootMount = `${toDockerPath(opts.root)}:/work`;
    const writesWholeRoot = allowed.some((p) => p === "." || p === "" || p === "./");
    const mounts: string[] = [];
    if (writesWholeRoot) {
      mounts.push("-v", `${rootMount}:rw`);
    } else {
      mounts.push("-v", `${rootMount}:ro`);
      for (const p of allowed) {
        const rel = p.replace(/\\/g, "/").replace(/^\.\//, "");
        if (!rel) continue;
        mounts.push("-v", `${toDockerPath(join(opts.root, rel))}:/work/${rel}:rw`);
      }
    }
    for (const extra of opts.extraReadOnlyMounts ?? []) {
      mounts.push("-v", `${toDockerPath(extra)}:${toDockerPath(extra)}:ro`);
    }

    const args = [
      "run",
      "--rm",
      "-i",
      "--network",
      opts.step.network ? "bridge" : "none",
      "--memory",
      `${limits.memoryMb}m`,
      "--cpus",
      String(limits.cpus),
      "--pids-limit",
      String(limits.pidsLimit),
      ...mounts,
      "-w",
      "/work",
      image,
      "bash",
      "-lc",
      cmd,
    ];

    const result = await (this.deps.runCommand ?? runWithTimeout)(
      "docker",
      args,
      limits.timeoutMs,
      undefined,
      scrubEnv()
    );
    let stderr = result.stderr;
    if (opts.step.network) {
      stderr =
        (stderr ? stderr + "\n" : "") +
        "[sandbox] network enabled (bridge mode; egress proxy not yet available)";
    }
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr,
      timedOut: result.timedOut,
    };
  }
}

// ---------------------------------------------------------------------------
// WSL + bubblewrap runner
// ---------------------------------------------------------------------------

/** Convert a Windows path to its WSL mount path (C:\foo\bar → /mnt/c/foo/bar). */
export function toWslPath(p: string): string {
  if (/^[A-Za-z]:[\\/]/.test(p)) {
    const drive = p[0]!.toLowerCase();
    const rest = p.slice(2).replace(/\\/g, "/");
    return `/mnt/${drive}${rest}`;
  }
  return p.replace(/\\/g, "/");
}

export interface WslRunnerDeps extends RunnerDeps {
  distro: string;
}

/**
 * Filesystem-isolation runner via `wsl.exe -d <distro> -- bwrap ...`.
 * The project root is ro-bind mounted first, then each allowed declared write
 * is re-bound read-write on top. `--unshare-net --unshare-pid
 * --die-with-parent` isolate the process; ulimits enforce memory/PID caps.
 * Network is NOT denied per invocation — this runner is filesystem-isolation
 * only, stated honestly in `description`.
 */
export class WslRunner implements SandboxRunner {
  readonly kind = "wsl-bwrap" as const;
  readonly description = "WSL + bubblewrap (filesystem isolation only — no per-invocation network deny)";

  private readonly deps: WslRunnerDeps;

  constructor(deps: WslRunnerDeps) {
    this.deps = deps;
  }

  async exec(cmd: string, opts: RunOpts): Promise<ExecResult> {
    const { allowed, blocked } = partitionWrites(opts.step.declaredWrites.map((w) => w.path));
    for (const p of blocked) {
      await recordDenial(this.deps, "config-guard", `Write to "${p}" blocked by config guard`, opts.step);
    }
    const limits = { ...DEFAULT_RESOURCE_LIMITS, ...opts.step.resourceLimits };
    const wslRoot = toWslPath(opts.root);

    const bwrapArgs: string[] = ["--ro-bind", wslRoot, wslRoot];
    for (const p of allowed) {
      const rel = p.replace(/\\/g, "/").replace(/^\.\//, "");
      const target = rel ? `${wslRoot}/${rel}` : wslRoot;
      bwrapArgs.push("--bind", target, target);
    }
    bwrapArgs.push(
      "--unshare-net",
      "--unshare-pid",
      "--die-with-parent",
      "bash",
      "-lc",
      `ulimit -v ${limits.memoryMb * 1024}; ulimit -u ${limits.pidsLimit}; ${cmd}`
    );

    const args = ["-d", this.deps.distro, "--", "bwrap", ...bwrapArgs];
    const result = await (this.deps.runCommand ?? runWithTimeout)(
      "wsl.exe",
      args,
      limits.timeoutMs,
      undefined,
      scrubEnv()
    );
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    };
  }
}

// ---------------------------------------------------------------------------
// Unsandboxed runner
// ---------------------------------------------------------------------------

/**
 * No OS-level sandbox. Runs the command through the platform shell directly
 * (`cmd /c` on win32, `/bin/sh -c` elsewhere — mirroring gates.ts). The
 * approval layer is the only guard; `description` says so.
 */
export class UnsandboxedRunner implements SandboxRunner {
  readonly kind = "unsandboxed" as const;
  readonly description =
    "No OS-level sandbox — approval layer only (every write/network action requires approval)";

  private readonly deps?: Pick<RunnerDeps, "runCommand">;

  constructor(deps?: Pick<RunnerDeps, "runCommand">) {
    this.deps = deps;
  }

  async exec(cmd: string, opts: RunOpts): Promise<ExecResult> {
    const limits = { ...DEFAULT_RESOURCE_LIMITS, ...opts.step.resourceLimits };
    const isWin = platform() === "win32";
    const bin = isWin ? "cmd" : "/bin/sh";
    const args = isWin ? ["/c", cmd] : ["-c", cmd];
    const result = await (this.deps?.runCommand ?? runWithTimeout)(
      bin,
      args,
      limits.timeoutMs,
      opts.root,
      scrubEnv()
    );
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    };
  }
}

// ---------------------------------------------------------------------------
// Probes + selection
// ---------------------------------------------------------------------------

let dockerProbeCache: boolean | undefined;
let wslProbeCache: { available: boolean; distro: string } | undefined;

/** Reset probe caches (test hygiene). */
export function resetSandboxProbes(): void {
  dockerProbeCache = undefined;
  wslProbeCache = undefined;
}

export async function probeDocker(): Promise<boolean> {
  if (dockerProbeCache !== undefined) return dockerProbeCache;
  const result = await runWithTimeout("docker", ["info"], 5000);
  dockerProbeCache = result.exitCode === 0;
  return dockerProbeCache;
}

export async function probeWslBwrap(
  distro?: string
): Promise<{ available: boolean; distro: string }> {
  if (wslProbeCache !== undefined) return wslProbeCache;
  if (platform() !== "win32") {
    wslProbeCache = { available: false, distro: "" };
    return wslProbeCache;
  }
  const list = await runWithTimeout("wsl.exe", ["-l", "-q"], 5000, undefined, undefined, "utf16le");
  if (list.exitCode !== 0) {
    wslProbeCache = { available: false, distro: "" };
    return wslProbeCache;
  }
  const distros = list.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 0 &&
        !/^Windows Subsystem for Linux$/i.test(l) &&
        !/^docker-desktop$/i.test(l)
    );
  const target = distro && distros.includes(distro) ? distro : distros[0];
  if (!target) {
    wslProbeCache = { available: false, distro: "" };
    return wslProbeCache;
  }
  const which = await runWithTimeout("wsl.exe", ["-d", target, "--", "which", "bwrap"], 5000);
  if (which.exitCode !== 0) {
    wslProbeCache = { available: false, distro: "" };
    return wslProbeCache;
  }
  wslProbeCache = { available: true, distro: target };
  return wslProbeCache;
}

export interface SelectRunnerDeps extends RunnerDeps {
  /** Test seam: override availability probes. */
  probeDocker?: () => Promise<boolean>;
  probeWslBwrap?: (distro?: string) => Promise<{ available: boolean; distro: string }>;
}

export interface SelectRunnerResult {
  runner: SandboxRunner;
  statusLine: string;
  supportsUnattendedAutonomy: boolean;
}

const NO_SANDBOX_LINE =
  "Sandbox: none available — install Docker Desktop for full isolation. Write actions will require approval.";

function unsandboxedResult(): SelectRunnerResult {
  return {
    runner: new UnsandboxedRunner(),
    statusLine: NO_SANDBOX_LINE,
    supportsUnattendedAutonomy: false,
  };
}

function dockerResult(deps: SelectRunnerDeps): SelectRunnerResult {
  return {
    runner: new DockerRunner(deps),
    statusLine: "Sandbox: Docker container (network denied by default, per-step write scope)",
    supportsUnattendedAutonomy: true,
  };
}

function wslResult(deps: SelectRunnerDeps, distro: string): SelectRunnerResult {
  return {
    runner: new WslRunner({ ...deps, distro }),
    statusLine: "Sandbox: WSL + bubblewrap (filesystem isolation only)",
    supportsUnattendedAutonomy: true,
  };
}

/**
 * Select the best available runner. Probe order: docker → (win32 only)
 * wsl+bwrap → unsandboxed. `backend: 'off'` forces the unsandboxed runner
 * (with the Tier-3 consequence handled by the caller via
 * `supportsUnattendedAutonomy`).
 */
export async function selectRunner(deps: SelectRunnerDeps): Promise<SelectRunnerResult> {
  const backend = deps.config?.backend;
  const dockerProbe = deps.probeDocker ?? probeDocker;
  const wslProbe = deps.probeWslBwrap ?? probeWslBwrap;

  if (backend === "off") return unsandboxedResult();

  if (backend === "docker") {
    return (await dockerProbe()) ? dockerResult(deps) : unsandboxedResult();
  }

  if (backend === "wsl") {
    const wsl = await wslProbe(deps.config?.wslDistro);
    return wsl.available ? wslResult(deps, wsl.distro) : unsandboxedResult();
  }

  if (await dockerProbe()) return dockerResult(deps);
  if (platform() === "win32") {
    const wsl = await wslProbe(deps.config?.wslDistro);
    if (wsl.available) return wslResult(deps, wsl.distro);
  }
  return unsandboxedResult();
}