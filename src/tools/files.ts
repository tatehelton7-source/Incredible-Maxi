import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import type { Tool, ToolResult } from "./types.js";
import { createPathGuard } from "./sandbox.js";

const PROJECT_ROOT = resolve(process.cwd());

/** Phase 4.2 — file tools cannot write outside the project root. */
const pathGuard = createPathGuard([PROJECT_ROOT]);

function validatePath(path: string): string {
  const absolute = isAbsolute(path) ? path : resolve(PROJECT_ROOT, path);
  const real = realpathSync(absolute);
  if (!real.startsWith(PROJECT_ROOT)) {
    throw new Error(`Path traversal denied: ${path}`);
  }
  return absolute;
}

async function read(path: string): Promise<ToolResult> {
  try {
    const safePath = validatePath(path);
    const content = await readFile(safePath, "utf-8");
    return { success: true, output: content };
  } catch (err) {
    return { success: false, output: "", error: `Failed to read ${path}: ${(err as Error).message}` };
  }
}

async function write(path: string, content: string): Promise<ToolResult> {
  try {
    pathGuard.assertWithinRoots(path);
    const safePath = validatePath(path);
    await writeFile(safePath, content, "utf-8");
    return { success: true, output: `Wrote ${content.length} bytes to ${path}` };
  } catch (err) {
    return { success: false, output: "", error: `Failed to write ${path}: ${(err as Error).message}` };
  }
}

async function edit(path: string, oldString: string, newString: string): Promise<ToolResult> {
  try {
    pathGuard.assertWithinRoots(path);
    const safePath = validatePath(path);
    const content = await readFile(safePath, "utf-8");
    const occurrences = content.split(oldString).length - 1;
    if (occurrences === 0) {
      return { success: false, output: "", error: `oldString not found in ${path}` };
    }
    if (occurrences > 1) {
      return { success: false, output: "", error: `oldString found ${occurrences} times in ${path}. Provide more context to make it unique.` };
    }
    const updated = content.replace(oldString, newString);
    await writeFile(safePath, updated, "utf-8");
    return { success: true, output: `Edited ${path}` };
  } catch (err) {
    return { success: false, output: "", error: `Failed to edit ${path}: ${(err as Error).message}` };
  }
}

async function listDir(path: string): Promise<ToolResult> {
  try {
    const safePath = validatePath(path);
    const entries = await readdir(safePath);
    const lines: string[] = [];
    for (const entry of entries) {
      const fullPath = join(safePath, entry);
      const s = await stat(fullPath);
      lines.push(`${s.isDirectory() ? "[DIR]" : "[FILE]"} ${entry}`);
    }
    return { success: true, output: lines.join("\n") };
  } catch (err) {
    return { success: false, output: "", error: `Failed to list ${path}: ${(err as Error).message}` };
  }
}

function globMatch(pattern: string, path: string): boolean {
  const regex = globToRegex(pattern);
  return regex.test(path);
}

function globToRegex(pattern: string): RegExp {
  let re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  re = re.replace(/\*\*/g, "::GLOBSTAR::");
  re = re.replace(/\*/g, "[^/]*");
  re = re.replace(/::GLOBSTAR::/g, ".*");
  re = re.replace(/\?/g, "[^/]");
  return new RegExp(`^${re}$`);
}

async function globSearch(pattern: string, cwd: string): Promise<ToolResult> {
  try {
    const results: string[] = [];
    async function walk(dir: string) {
      if (!existsSync(dir)) return;
      const entries = await readdir(dir);
      for (const entry of entries) {
        if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
        const fullPath = join(dir, entry);
        const relPath = relative(cwd, fullPath);
        const s = await stat(fullPath);
        if (s.isDirectory()) {
          await walk(fullPath);
        } else if (globMatch(pattern, relPath) || globMatch(pattern, entry)) {
          results.push(relPath);
        }
      }
    }
    await walk(cwd);
    return { success: true, output: results.join("\n") };
  } catch (err) {
    return { success: false, output: "", error: `Glob search failed: ${(err as Error).message}` };
  }
}

async function grep(pattern: string, cwd: string, include?: string): Promise<ToolResult> {
  try {
    const regex = new RegExp(pattern, "i");
    const results: string[] = [];
    async function walk(dir: string) {
      if (!existsSync(dir)) return;
      const entries = await readdir(dir);
      for (const entry of entries) {
        if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
        const fullPath = join(dir, entry);
        const s = await stat(fullPath);
        if (s.isDirectory()) {
          await walk(fullPath);
        } else {
          if (include && !globMatch(include, entry)) continue;
          const content = await readFile(fullPath, "utf-8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              const relPath = relative(cwd, fullPath);
              results.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
            }
          }
        }
      }
    }
    await walk(cwd);
    return { success: true, output: results.join("\n") };
  } catch (err) {
    return { success: false, output: "", error: `Grep failed: ${(err as Error).message}` };
  }
}

export const readFileTool: Tool = {
  name: "readFile",
  description: "Read the contents of a file",
  execute: async (args) => read(args.path as string),
};

export const writeFileTool: Tool = {
  name: "writeFile",
  description: "Write content to a file",
  execute: async (args) => write(args.path as string, args.content as string),
};

export const editFileTool: Tool = {
  name: "editFile",
  description: "Find and replace a string in a file",
  execute: async (args) => edit(args.path as string, args.oldString as string, args.newString as string),
};

export const listDirectoryTool: Tool = {
  name: "listDirectory",
  description: "List directory entries with [FILE]/[DIR] prefixes",
  execute: async (args) => listDir(args.path as string),
};

export const globTool: Tool = {
  name: "glob",
  description: "Search for files matching a glob pattern",
  execute: async (args) => globSearch(args.pattern as string, (args.cwd as string) || process.cwd()),
};

export const grepTool: Tool = {
  name: "grep",
  description: "Search file contents using a regex pattern",
  execute: async (args) => grep(args.pattern as string, (args.cwd as string) || process.cwd(), args.include as string | undefined),
};