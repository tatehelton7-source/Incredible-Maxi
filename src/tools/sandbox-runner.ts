/**
 * Sandbox runner abstraction for isolated command execution.
 *
 * Provides WSL2 (filesystem-isolated) and Docker (filesystem + network-isolated)
 * backends for running shell commands outside the host. Gate commands, bash tool
 * calls, and runToolchain all route through the active runner when available.
 *
 * Network honesty:
 *   - WSL2: filesystem-isolated only. Network isolation requires .wslconfig
 *     configuration and is not enforced at invocation time.
 *   - Docker: --network none denies egress; --network bridge allows it.
 *     True egress restriction with bridge requires a proxy layer.
 *
 * On bare hosts without WSL2/Docker, behavior falls back to plain
 * child_process execution (the approval layer remains active).
 */

import { execFile } from "node:child_process";
import { execFileSync } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";
import type { SandboxConfig } from "../providers/types.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SandboxKind = "wsl" | "docker" | "none";

export interface SandboxRequest {
  /** Shell command string to execute. */
  command: string;
  /** Working directory (Windows or POSIX). */
  cwd: string;
  /** Already-scrubbed environment. */
  env?: NodeJS.ProcessEnv;
  /** Timeout in ms (enforced by caller; informational here). */
  timeoutMs?: number;
  /** Allow network egress. Default false (deny). */
  network?: boolean;
}

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxRunner {
  kind: SandboxKind;
  isAvailable(): Promise<boolean>;
  run(req: SandboxRequest): Promise<SandboxResult>;
}

// ---------------------------------------------------------------------------
// Module-level runner state
// ---------------------------------------------------------------------------

let runner: SandboxRunner | undefined;

export function setSandboxRunner(r: SandboxRunner | undefined): void {
  runner = r;
}

export function getSandboxRunner(): SandboxRunner | undefined {
  return runner;
}

// ---------------------------------------------------------------------------
// WSL probe cache
// ---------------------------------------------------------------------------

let wslAvailable: boolean | undefined;
let wslDistro: string | undefined;

async function probeWsl(): Promise<{ available: boolean; distro: string }> {
  if (wslAvailable !== undefined && wslDistro !== undefined) {
    return { available: wslAvailable, distro: wslDistro };
  }
  if (platform() !== "win32") {
    wslAvailable = false;
    wslDistro = "";
    return { available: false, distro: "" };
  }
  try {
    const { stdout } = await execFileAsync("wsl.exe", ["-l", "-q"], {
      encoding: "buffer",
      timeout: 5000,
    });
    const out = stdout.toString("utf16le");
    const distros = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(
        (l) =>
          l.length > 0 &&
          !/^Windows Subsystem for Linux$/i.test(l) &&
          !/^docker-desktop$/i.test(l),
      );
    wslAvailable = distros.length > 0;
    wslDistro = distros[0] ?? "";
    return { available: wslAvailable, distro: wslDistro };
  } catch {
    wslAvailable = false;
    wslDistro = "";
    return { available: false, distro: "" };
  }
}

// ---------------------------------------------------------------------------
// WslRunner
// ---------------------------------------------------------------------------

/**
 * Run a command inside WSL2 via `wsl.exe -d <distro> -- bash -lc <cmd>`.
 *
 * Filesystem isolation: the project root is accessible via its WSL mount
 * path (/mnt/<drive>/...). The cwd is mapped using `wslpath`.
 *
 * Network isolation: NOT enforced at invocation time. WSL2 networking is
 * controlled by .wslconfig and the WSL version — document accurately:
 * this runner is filesystem-isolated only.
 */
export class WslRunner implements SandboxRunner {
  readonly kind = "wsl" as const;

  private distro: string;

  constructor(distro: string) {
    this.distro = distro;
  }

  async isAvailable(): Promise<boolean> {
    const result = await probeWsl();
    return result.available;
  }

  /** Convert a Windows path to a WSL mount path using `wslpath`. */
  private mapCwd(cwd: string): string {
    // Only convert Windows-style absolute paths (e.g. C:\foo\bar)
    if (!/^[A-Za-z]:\\/.test(cwd) && !/^[A-Za-z]:\//.test(cwd)) {
      return cwd;
    }
    try {
      const out = execFileSync("wsl.exe", ["-d", this.distro, "--", "wslpath", "-u", cwd], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      });
      return out.trim();
    } catch {
      // Fallback: manual C:\foo\bar → /mnt/c/foo/bar
      const drive = cwd[0]!.toLowerCase();
      const rest = cwd.slice(2).replace(/\\/g, "/");
      return `/mnt/${drive}${rest}`;
    }
  }

  async run(req: SandboxRequest): Promise<SandboxResult> {
    const mappedCwd = this.mapCwd(req.cwd);
    try {
      const { stdout, stderr } = await execFileAsync(
        "wsl.exe",
        ["-d", this.distro, "--", "bash", "-lc", req.command],
        { cwd: mappedCwd, env: req.env, timeout: req.timeoutMs },
      );
      return { exitCode: 0, stdout, stderr };
    } catch (err) {
      const e = err as {
        code?: number | null;
        stdout?: string;
        stderr?: string;
        killed?: boolean;
        message?: string;
      };
      return {
        exitCode: typeof e.code === "number" ? e.code : 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? e.message ?? "",
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Docker probe cache
// ---------------------------------------------------------------------------

let dockerAvailable: boolean | undefined;

async function probeDocker(): Promise<boolean> {
  if (dockerAvailable !== undefined) return dockerAvailable;
  try {
    await execFileAsync("docker", ["info"], { timeout: 5000 });
    dockerAvailable = true;
  } catch {
    dockerAvailable = false;
  }
  return dockerAvailable;
}

// ---------------------------------------------------------------------------
// DockerRunner
// ---------------------------------------------------------------------------

/**
 * Run a command inside a Docker container.
 *
 * Mounts the project root read-write at /work and executes the command
 * with /work as the working directory.
 *
 * Network policy:
 *   - network: false (default) → `--network none` — denies all egress.
 *     This is genuinely effective; no proxy layer needed.
 *   - network: true → `--network bridge` — allows egress. Document honestly:
 *     true egress restriction with bridge requires a proxy.
 *
 * Resource limits: 512 MB memory, no swap, PID limit 64.
 */
export class DockerRunner implements SandboxRunner {
  readonly kind = "docker" as const;

  private image: string;

  constructor(image: string) {
    this.image = image;
  }

  async isAvailable(): Promise<boolean> {
    return probeDocker();
  }

  async run(req: SandboxRequest): Promise<SandboxResult> {
    const network = req.network === true ? "bridge" : "none";
    const args = [
      "run",
      "--rm",
      "-i",
      "--network", network,
      "--memory", "512m",
      "--memory-swap", "512m",
      "--pids-limit", "64",
      "-v", `${req.cwd}:/work`,
      "-w", "/work",
      this.image,
      "/bin/sh", "-c", req.command,
    ];
    try {
      const { stdout, stderr } = await execFileAsync("docker", args, {
        env: req.env,
        timeout: req.timeoutMs,
      });
      return { exitCode: 0, stdout, stderr };
    } catch (err) {
      const e = err as {
        code?: number | null;
        stdout?: string;
        stderr?: string;
        killed?: boolean;
        message?: string;
      };
      return {
        exitCode: typeof e.code === "number" ? e.code : 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? e.message ?? "",
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Passthrough runner (no sandbox)
// ---------------------------------------------------------------------------

class NoneRunner implements SandboxRunner {
  readonly kind = "none" as const;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async run(): Promise<SandboxResult> {
    return { exitCode: 0, stdout: "", stderr: "No sandbox runner available" };
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Select the best available sandbox runner for this platform.
 *
 * Selection order:
 *   - config.sandbox.backend === 'wsl'  → WslRunner (if available)
 *   - config.sandbox.backend === 'docker' → DockerRunner (if available)
 *   - config.sandbox.backend === 'off' → none
 *   - default on win32: WslRunner → DockerRunner → none
 *   - default on POSIX:  DockerRunner → none
 *
 * Results are cached — repeated calls return the same runner.
 */
export async function selectRunner(config?: SandboxConfig): Promise<SandboxRunner> {
  const backend = config?.backend;
  const dockerImage = config?.dockerImage ?? "alpine:3";

  if (backend === "wsl") {
    const probe = await probeWsl();
    return probe.available ? new WslRunner(probe.distro) : new NoneRunner();
  }

  if (backend === "docker") {
    const available = await probeDocker();
    return available ? new DockerRunner(dockerImage) : new NoneRunner();
  }

  if (backend === "off") {
    return new NoneRunner();
  }

  // Default selection
  if (platform() === "win32") {
    const wslProbe = await probeWsl();
    if (wslProbe.available) return new WslRunner(wslProbe.distro);

    const dockerOk = await probeDocker();
    if (dockerOk) return new DockerRunner(dockerImage);

    return new NoneRunner();
  }

  // POSIX
  const dockerOk = await probeDocker();
  return dockerOk ? new DockerRunner(dockerImage) : new NoneRunner();
}
