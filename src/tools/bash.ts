import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolResult } from "./types.js";
import { scrubEnv } from "./env.js";
import { getSandboxRunner, getCurrentStepIntent, defaultStepIntent } from "./sandbox-runners.js";

const execAsync = promisify(exec);

const MAX_TIMEOUT = 120000;
const DEFAULT_TIMEOUT = 30000;

async function runBash(
  command: string,
  cwd?: string,
  timeout?: number
): Promise<ToolResult> {
  const effectiveTimeout = Math.min(timeout || DEFAULT_TIMEOUT, MAX_TIMEOUT);

  // Security: log every command before execution
  console.error(`[bash] ${command}`);

  const runner = getSandboxRunner();
  const env = scrubEnv();
  const root = cwd || process.cwd();

  try {
    let stdout: string;
    let stderr: string;

    if (runner) {
      const step = getCurrentStepIntent() ?? defaultStepIntent();
      const result = await runner.exec(command, {
        root,
        step: { ...step, resourceLimits: { ...step.resourceLimits, timeoutMs: effectiveTimeout } },
      });
      if (result.sandboxDenial) {
        return {
          success: false,
          output: "",
          error: `Sandbox denial (${result.sandboxDenial.layer}): ${result.sandboxDenial.detail}`,
        };
      }
      stdout = result.stdout;
      stderr = result.stderr;
    } else {
      const raw = await execAsync(command, {
        cwd: root,
        timeout: effectiveTimeout,
        maxBuffer: 1024 * 1024 * 10,
        env,
      });
      stdout = raw.stdout;
      stderr = raw.stderr;
    }

    const output = [stdout, stderr].filter(Boolean).join("\n");
    return { success: true, output: output || "(no output)" };
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
    if (error.killed) {
      return {
        success: false,
        output: "",
        error: `Command timed out after ${effectiveTimeout}ms`,
      };
    }
    const output = [error.stdout, error.stderr].filter(Boolean).join("\n");
    return {
      success: false,
      output,
      error: `Command failed: ${error.message}`,
    };
  }
}

export const bashTool: Tool = {
  name: "bash",
  description: "Execute a shell command with timeout and output capture",
  execute: async (args) =>
    runBash(
      args.command as string,
      args.cwd as string | undefined,
      args.timeout as number | undefined
    ),
};