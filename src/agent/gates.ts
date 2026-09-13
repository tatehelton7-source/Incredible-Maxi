/**
 * Phase 4.1 — Verification gates.
 *
 * A plan step's `gate` is a shell command whose exit 0 is the only path to
 * `verified`. This module owns the two pure-ish pieces of that contract:
 *
 *   - `runGateCommand`: execute a gate command via the platform shell and
 *     capture its exit code + combined output (tail 2000 chars). The only
 *     side effect is the child process itself; the caller decides what to do
 *     with the result.
 *   - `detectToolchainGates`: probe a project directory for test/lint tooling
 *     and return candidate gate commands. An empty result means "no toolchain"
 *     — the no-toolchain fallback (approval-gated writes) applies.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scrubEnv } from "../tools/env.js";
import { getSandboxRunner, getCurrentStepIntent, defaultStepIntent } from "../tools/sandbox-runners.js";

const execFileAsync = promisify(execFile);

/** Gate commands are capped at 5 minutes; a hung gate must not wedge the loop. */
const GATE_TIMEOUT_MS = 5 * 60 * 1000;

/** Combined output is truncated to the last 2000 chars for step.lastError. */
const OUTPUT_TAIL = 2000;

export interface GateCommandResult {
  /** Process exit code. Non-zero (or a timeout) means the gate failed. */
  exitCode: number;
  /** Combined stdout+stderr, tail-truncated to 2000 chars. */
  output: string;
}

/**
 * Run a gate command through the platform shell and capture its exit code and
 * combined output. On win32 the command runs via `cmd /c`; elsewhere via
 * `/bin/sh -c`. The child inherits a scrubbed environment (no credential keys)
 * and runs in `cwd`. A timeout or spawn failure surfaces as a non-zero exit.
 */
export async function runGateCommand(
  command: string,
  opts: { cwd: string; env?: NodeJS.ProcessEnv }
): Promise<GateCommandResult> {
  const runner = getSandboxRunner();

  if (runner) {
    try {
      const step = getCurrentStepIntent() ?? defaultStepIntent();
      const result = await runner.exec(command, {
        root: opts.cwd,
        step: { ...step, resourceLimits: { ...step.resourceLimits, timeoutMs: GATE_TIMEOUT_MS } },
      });
      const combined = (result.stdout + result.stderr).slice(-OUTPUT_TAIL);
      return { exitCode: result.exitCode ?? 1, output: combined };
    } catch {
      return { exitCode: 1, output: "Sandbox runner failed unexpectedly" };
    }
  }

  const isWin = process.platform === "win32";
  const file = isWin ? "cmd" : "/bin/sh";
  const args = isWin ? ["/c", command] : ["-c", command];

  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? scrubEnv(),
      timeout: GATE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return { exitCode: 0, output: (stdout + stderr).slice(-OUTPUT_TAIL) };
  } catch (err) {
    const e = err as { code?: number | null; stdout?: string; stderr?: string; message?: string };
    const exitCode = typeof e.code === "number" ? e.code : 1;
    const combined = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    const output = (combined.trim() ? combined : e.message ?? "").slice(-OUTPUT_TAIL);
    return { exitCode, output };
  }
}

/**
 * Probe `cwd` for test/lint tooling and return candidate gate commands.
 * Pure function — never touches the network or mutates state.
 *
 * Heuristics:
 *   - package.json `scripts` with a non-empty test/lint/check/verify → `npm run <name>`
 *   - pyproject.toml mentioning pytest, or a pytest.ini → `python -m pytest`
 *   - Cargo.toml → `cargo test`
 *   - go.mod → `go test ./...`
 *   - Makefile with a `test:` target → `make test`
 *
 * An empty array means no toolchain was detected.
 */
export function detectToolchainGates(cwd: string): string[] {
  const gates: string[] = [];

  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        scripts?: Record<string, unknown>;
      };
      const scripts = pkg.scripts ?? {};
      for (const name of ["test", "lint", "check", "verify"]) {
        if (typeof scripts[name] === "string" && scripts[name].trim()) {
          gates.push(`npm run ${name}`);
        }
      }
    } catch {
      // Malformed package.json — treat as no npm tooling.
    }
  }

  const pyprojectPath = join(cwd, "pyproject.toml");
  if (existsSync(pyprojectPath)) {
    try {
      if (/pytest/.test(readFileSync(pyprojectPath, "utf-8"))) {
        gates.push("python -m pytest");
      }
    } catch {
      // Unreadable pyproject.toml — skip.
    }
  }
  if (existsSync(join(cwd, "pytest.ini"))) {
    gates.push("python -m pytest");
  }

  if (existsSync(join(cwd, "Cargo.toml"))) {
    gates.push("cargo test");
  }
  if (existsSync(join(cwd, "go.mod"))) {
    gates.push("go test ./...");
  }

  const makefilePath = join(cwd, "Makefile");
  if (existsSync(makefilePath)) {
    try {
      if (/^test\s*:/m.test(readFileSync(makefilePath, "utf-8"))) {
        gates.push("make test");
      }
    } catch {
      // Unreadable Makefile — skip.
    }
  }

  return gates;
}
