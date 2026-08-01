import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolResult } from "./tools/types.js";

const execFileAsync = promisify(execFile);

function spawnAsync(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd: options.cwd });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (data) => (stdout += data.toString()));
    proc.stderr?.on("data", (data) => (stderr += data.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Command failed with code ${code}: ${stderr}`));
    });
    if (options.input) {
      proc.stdin?.write(options.input);
      proc.stdin?.end();
    }
  });
}

export interface GitConfig {
  autoStage: boolean;
  defaultBranch: string;
}

export async function gitStatus(cwd: string): Promise<ToolResult> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd });
    return { success: true, output: stdout || "Working tree clean" };
  } catch (err) {
    return { success: false, output: "", error: `git status failed: ${(err as Error).message}` };
  }
}

export async function gitDiff(cwd: string, staged: boolean = false): Promise<ToolResult> {
  try {
    const args = staged ? ["diff", "--cached"] : ["diff"];
    const { stdout } = await execFileAsync("git", args, { cwd });
    return { success: true, output: stdout || "No changes" };
  } catch (err) {
    return { success: false, output: "", error: `git diff failed: ${(err as Error).message}` };
  }
}

export async function gitLog(cwd: string, count: number = 10): Promise<ToolResult> {
  try {
    const { stdout } = await execFileAsync("git", ["log", "--oneline", `-${count}`], { cwd });
    return { success: true, output: stdout };
  } catch (err) {
    return { success: false, output: "", error: `git log failed: ${(err as Error).message}` };
  }
}

export async function gitAdd(cwd: string, files: string[]): Promise<ToolResult> {
  try {
    const args = ["add", "--", ...files];
    await execFileAsync("git", args, { cwd });
    return { success: true, output: `Staged ${files.length > 0 ? files.length : "all"} files` };
  } catch (err) {
    return { success: false, output: "", error: `git add failed: ${(err as Error).message}` };
  }
}

export async function gitCommit(cwd: string, message: string): Promise<ToolResult> {
  try {
    const { stdout } = await spawnAsync("git", ["commit", "-F", "-"], {
      cwd,
      input: message,
    });
    return { success: true, output: stdout };
  } catch (err) {
    return { success: false, output: "", error: `git commit failed: ${(err as Error).message}` };
  }
}

export async function gitBranch(cwd: string): Promise<ToolResult> {
  try {
    const { stdout } = await execFileAsync("git", ["branch", "-a"], { cwd });
    return { success: true, output: stdout };
  } catch (err) {
    return { success: false, output: "", error: `git branch failed: ${(err as Error).message}` };
  }
}

export async function gitCheckout(cwd: string, branch: string): Promise<ToolResult> {
  try {
    if (!/^[a-zA-Z0-9._/-]+$/.test(branch)) {
      return { success: false, output: "", error: `Invalid branch name: ${branch}` };
    }
    const { stdout } = await execFileAsync("git", ["checkout", branch], { cwd });
    return { success: true, output: stdout || `Switched to branch ${branch}` };
  } catch (err) {
    return { success: false, output: "", error: `git checkout failed: ${(err as Error).message}` };
  }
}

export const gitStatusTool: Tool = {
  name: "gitStatus",
  description: "Show git working tree status",
  execute: async (args) => gitStatus((args.cwd as string) || process.cwd()),
};

export const gitDiffTool: Tool = {
  name: "gitDiff",
  description: "Show git diff (unstaged or staged)",
  execute: async (args) => gitDiff((args.cwd as string) || process.cwd(), args.staged as boolean | undefined),
};

export const gitLogTool: Tool = {
  name: "gitLog",
  description: "Show recent git commits",
  execute: async (args) => gitLog((args.cwd as string) || process.cwd(), (args.count as number) || 10),
};

export const gitAddTool: Tool = {
  name: "gitAdd",
  description: "Stage files for commit",
  execute: async (args) => gitAdd((args.cwd as string) || process.cwd(), (args.files as string[]) || []),
};

export const gitCommitTool: Tool = {
  name: "gitCommit",
  description: "Create a git commit",
  execute: async (args) => gitCommit((args.cwd as string) || process.cwd(), args.message as string),
};

export const gitBranchTool: Tool = {
  name: "gitBranch",
  description: "List git branches",
  execute: async (args) => gitBranch((args.cwd as string) || process.cwd()),
};

export const gitCheckoutTool: Tool = {
  name: "gitCheckout",
  description: "Switch git branch",
  execute: async (args) => gitCheckout((args.cwd as string) || process.cwd(), args.branch as string),
};