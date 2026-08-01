import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolResult } from "./types.js";

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

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: cwd || process.cwd(),
      timeout: effectiveTimeout,
      maxBuffer: 1024 * 1024 * 10,
    });

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
