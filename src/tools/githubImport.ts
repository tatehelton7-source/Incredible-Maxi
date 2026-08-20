import type { MaxiConfig } from "../providers/types.js";
import type { ToolResult } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MaxiPluginManifest {
  name: string;
  skills?: string[];
  mcpServers?: Array<{
    name: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
  }>;
  tools?: Array<{
    path: string;
    type: "ts" | "subprocess" | "wasm";
  }>;
}

export interface ImportItem {
  kind: "skill" | "mcpServer" | "tool";
  path: string;
  discoveredVia: "manifest" | "convention";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  toolType?: "ts" | "subprocess" | "wasm";
  sourcePreview?: string;
  sizeBytes?: number;
  sha?: string;
  hasInstallScript?: boolean;
}

export interface ImportPreviewReport {
  owner: string;
  repo: string;
  ref: string;
  resolvedSha: string;
  manifestFound: boolean;
  items: ImportItem[];
  warnings: string[];
}

export interface ImportLogEntry {
  timestamp: string;
  action: "preview" | "install";
  triggeredBy: "user" | "llm";
  repo: string;
  ref: string;
  details: string;
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

function parseGithubUrl(
  input: string,
): { owner: string; repo: string; ref?: string } | null {
  const trimmed = input.trim().replace(/\.git$/, "");
  const urlMatch = trimmed.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/#]+)(?:\/tree\/([^/]+))?/,
  );
  if (urlMatch) {
    return {
      owner: urlMatch[1],
      repo: urlMatch[2],
      ref: urlMatch[3] || undefined,
    };
  }
  const shortMatch = trimmed.match(/^([^/]+)\/([^/@#]+)(?:@(.+))?$/);
  if (shortMatch) {
    return {
      owner: shortMatch[1],
      repo: shortMatch[2],
      ref: shortMatch[3] || undefined,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

function authHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "maxi/0.1.0",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function resolveCommitSha(
  owner: string,
  repo: string,
  ref: string,
  token?: string,
): Promise<string> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
    { headers: authHeaders(token) },
  );
  if (!res.ok)
    throw new Error(`Failed to resolve ref "${ref}": ${res.status}`);
  const data = (await res.json()) as { sha: string };
  return data.sha;
}

async function fetchRepoTree(
  owner: string,
  repo: string,
  sha: string,
  token?: string,
): Promise<{
  entries: Array<{ path: string; type: string }>;
  truncated: boolean;
}> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`,
    { headers: authHeaders(token) },
  );
  if (!res.ok) throw new Error(`Failed to fetch repo tree: ${res.status}`);
  const data = (await res.json()) as {
    tree: Array<{ path: string; type: string }>;
    truncated: boolean;
  };
  return { entries: data.tree || [], truncated: data.truncated };
}

async function fetchRawFile(
  owner: string,
  repo: string,
  sha: string,
  path: string,
  token?: string,
  maxBytes = 200_000,
): Promise<string> {
  const res = await fetch(
    `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${path}`,
    { headers: authHeaders(token) },
  );
  if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
  const text = await res.text();
  if (text.length > maxBytes) {
    return (
      text.substring(0, maxBytes) + `\n\n[truncated at ${maxBytes} bytes]`
    );
  }
  return text;
}

async function tryFetchManifest(
  owner: string,
  repo: string,
  sha: string,
  token?: string,
): Promise<MaxiPluginManifest | null> {
  try {
    const raw = await fetchRawFile(owner, repo, sha, "maxi.plugin.json", token);
    return JSON.parse(raw) as MaxiPluginManifest;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Path sanitization
// ---------------------------------------------------------------------------

function isSafeRepoPath(path: string): boolean {
  if (!path || path.length === 0) return false;
  if (path.includes("\\")) return false;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  if (path.split("/").includes("..")) return false;
  const normalized = path
    .split("/")
    .filter((s) => s !== "" && s !== ".")
    .join("/");
  return normalized === path;
}

// ---------------------------------------------------------------------------
// Preview (LLM-callable, read-only)
// ---------------------------------------------------------------------------

export async function githubImportPreview(
  config: MaxiConfig,
  repoInput: string,
  ref?: string,
): Promise<{
  result: ToolResult;
  report: ImportPreviewReport | null;
  logEntry: ImportLogEntry;
}> {
  const parsed = parseGithubUrl(repoInput);
  if (!parsed) {
    return {
      result: {
        success: false,
        output: "",
        error: `Invalid GitHub URL or shorthand: ${repoInput}`,
      },
      report: null,
      logEntry: {
        timestamp: new Date().toISOString(),
        action: "preview",
        triggeredBy: "llm",
        repo: repoInput,
        ref: "",
        details: "Invalid URL",
      },
    };
  }

  const { owner, repo } = parsed;
  const token = config.githubToken;
  const resolvedRef = ref || parsed.ref || "main";

  let resolvedSha: string;
  try {
    resolvedSha = await resolveCommitSha(owner, repo, resolvedRef, token);
  } catch (err) {
    return {
      result: {
        success: false,
        output: "",
        error: `Failed to resolve ref "${resolvedRef}": ${(err as Error).message}`,
      },
      report: null,
      logEntry: {
        timestamp: new Date().toISOString(),
        action: "preview",
        triggeredBy: "llm",
        repo: `${owner}/${repo}`,
        ref: resolvedRef,
        details: "Failed to resolve ref",
      },
    };
  }

  const warnings: string[] = [];
  const items: ImportItem[] = [];
  let manifestFound = false;

  const manifest = await tryFetchManifest(owner, repo, resolvedSha, token);

  if (manifest) {
    manifestFound = true;

    if (manifest.skills) {
      for (const skillPath of manifest.skills) {
        if (!isSafeRepoPath(skillPath)) {
          warnings.push(`Skipped unsafe skill path: ${skillPath}`);
          continue;
        }
        items.push({
          kind: "skill",
          path: skillPath,
          discoveredVia: "manifest",
        });
      }
    }

    if (manifest.mcpServers) {
      for (const mcp of manifest.mcpServers) {
        items.push({
          kind: "mcpServer",
          path: mcp.name,
          discoveredVia: "manifest",
          command: mcp.command,
          args: mcp.args,
          env: mcp.env,
        });
      }
    }

    if (manifest.tools) {
      for (const tool of manifest.tools) {
        if (!isSafeRepoPath(tool.path)) {
          warnings.push(`Skipped unsafe tool path: ${tool.path}`);
          continue;
        }
        try {
          const source = await fetchRawFile(
            owner,
            repo,
            resolvedSha,
            tool.path,
            token,
          );
          items.push({
            kind: "tool",
            path: tool.path,
            discoveredVia: "manifest",
            toolType: tool.type,
            sourcePreview: source.substring(0, 500),
          });
        } catch {
          warnings.push(`Could not fetch tool source: ${tool.path}`);
        }
      }
    }
  } else {
    const tree = await fetchRepoTree(owner, repo, resolvedSha, token);
    if (tree.truncated) {
      return {
        result: {
          success: false,
          output: "",
          error:
            "Repo is too large to safely convention-scan without a manifest (tree exceeds 2000 entries). Add a maxi.plugin.json to declare exactly what to import.",
        },
        report: null,
        logEntry: {
          timestamp: new Date().toISOString(),
          action: "preview",
          triggeredBy: "llm",
          repo: `${owner}/${repo}`,
          ref: resolvedSha,
          details: "Tree too large, no manifest",
        },
      };
    }

    for (const entry of tree.entries) {
      if (entry.type !== "blob") continue;

      if (entry.path.startsWith("skills/") && entry.path.endsWith(".md")) {
        items.push({
          kind: "skill",
          path: entry.path,
          discoveredVia: "convention",
        });
        warnings.push(
          `Discovered via convention: ${entry.path} — review carefully`,
        );
      }

      if (entry.path.startsWith("tools/") && entry.path !== "tools/") {
        const ext = entry.path.split(".").pop();
        let toolType: "ts" | "subprocess" | "wasm" | undefined;
        if (ext === "ts" || ext === "js" || ext === "mjs") toolType = "ts";
        else if (ext === "wasm") toolType = "wasm";

        if (toolType) {
          try {
            const source = await fetchRawFile(
              owner,
              repo,
              resolvedSha,
              entry.path,
              token,
            );
            items.push({
              kind: "tool",
              path: entry.path,
              discoveredVia: "convention",
              toolType,
              sourcePreview: source.substring(0, 500),
            });
            warnings.push(
              `Discovered via convention: ${entry.path} — review carefully.`,
            );
          } catch {
            warnings.push(`Could not fetch tool source: ${entry.path}`);
          }
        }
      }

      if (entry.path === "mcp.json") {
        try {
          const raw = await fetchRawFile(
            owner,
            repo,
            resolvedSha,
            "mcp.json",
            token,
          );
          const mcpConfig = JSON.parse(raw) as {
            name: string;
            command: string;
            args?: string[];
            env?: Record<string, string>;
          };
          items.push({
            kind: "mcpServer",
            path: "mcp.json",
            discoveredVia: "convention",
            command: mcpConfig.command,
            args: mcpConfig.args || [],
            env: mcpConfig.env,
          });
          warnings.push(
            "Discovered via convention: mcp.json — review carefully.",
          );
        } catch {
          warnings.push("Could not parse mcp.json");
        }
      }
    }
  }

  const report: ImportPreviewReport = {
    owner,
    repo,
    ref: resolvedRef,
    resolvedSha,
    manifestFound,
    items,
    warnings,
  };

  const formatted = formatPreviewReport(report);

  return {
    result: { success: true, output: formatted },
    report,
    logEntry: {
      timestamp: new Date().toISOString(),
      action: "preview",
      triggeredBy: "llm",
      repo: `${owner}/${repo}`,
      ref: resolvedSha,
      details: `${items.length} items found${manifestFound ? " (manifest)" : " (convention)"}`,
    },
  };
}

function formatPreviewReport(report: ImportPreviewReport): string {
  const lines: string[] = [];
  lines.push(`# ${report.owner}/${report.repo}`);
  lines.push(`Ref: ${report.ref}`);
  lines.push(`SHA: ${report.resolvedSha}`);
  lines.push(
    `Manifest: ${report.manifestFound ? "found" : "not found — convention scan"}`,
  );
  lines.push("");

  if (report.warnings.length > 0) {
    lines.push("## Warnings");
    for (const w of report.warnings) {
      lines.push(`- ${w}`);
    }
    lines.push("");
  }

  if (report.items.length === 0) {
    lines.push("No importable items found.");
  } else {
    lines.push("## Items");
    for (const item of report.items) {
      lines.push(`- [${item.kind}] ${item.path} (${item.discoveredVia})`);
      if (item.command)
        lines.push(`  command: ${item.command} ${(item.args || []).join(" ")}`);
      if (item.toolType) lines.push(`  type: ${item.toolType}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Install (slash-command only, NEVER in getTools())
// ---------------------------------------------------------------------------

export async function githubInstall(
  config: MaxiConfig,
  report: ImportPreviewReport,
  confirm: (message: string) => Promise<boolean>,
): Promise<{ result: ToolResult; logEntry: ImportLogEntry }> {
  const { owner, repo, resolvedSha } = report;
  const token = config.githubToken;
  const installed: string[] = [];
  const declined: string[] = [];

  const skills = report.items.filter((i) => i.kind === "skill");
  if (skills.length > 0) {
    const names = skills.map((s) => s.path).join(", ");
    const ok = await confirm(
      `Install ${skills.length} skill(s): ${names}? (Skills are inert markdown — no executable code)`,
    );
    if (ok) {
      for (const skill of skills) {
        try {
          const content = await fetchRawFile(
            owner,
            repo,
            resolvedSha,
            skill.path,
            token,
          );
          const { mkdirSync, writeFileSync } = await import("node:fs");
          const { join } = await import("node:path");
          const destDir = join(
            process.cwd(),
            ".maxi",
            "imported",
            `${owner}-${repo}`,
            "skills",
          );
          mkdirSync(destDir, { recursive: true });
          writeFileSync(
            join(destDir, skill.path.split("/").pop()!),
            content,
            "utf-8",
          );
          installed.push(`skill:${skill.path}`);
        } catch (err) {
          declined.push(
            `skill:${skill.path} (error: ${(err as Error).message})`,
          );
        }
      }
    } else {
      for (const s of skills) declined.push(`skill:${s.path} (declined)`);
    }
  }

  const mcpServers = report.items.filter((i) => i.kind === "mcpServer");
  for (const mcp of mcpServers) {
    const msg = `Install MCP server "${mcp.path}"?\n  Command: ${mcp.command} ${(mcp.args || []).join(" ")}${mcp.env ? `\n  Env: ${JSON.stringify(mcp.env)}` : ""}`;
    const ok = await confirm(msg);
    if (ok) {
      installed.push(`mcp:${mcp.path}`);
    } else {
      declined.push(`mcp:${mcp.path} (declined)`);
    }
  }

  const tools = report.items.filter((i) => i.kind === "tool");
  for (const tool of tools) {
    if (tool.toolType === "wasm") {
      const msg = `Install WASM tool "${tool.path}"?\n  Size: ${tool.sizeBytes || "unknown"} bytes\n  SHA: ${tool.sha || "unknown"}\n  WARNING: This is a compiled binary — its source cannot be reviewed as text. Confirming means you trust the source repo, not that you've reviewed the code.`;
      const ok = await confirm(msg);
      if (ok) installed.push(`tool:${tool.path}`);
      else declined.push(`tool:${tool.path} (declined)`);
    } else {
      const preview = tool.sourcePreview || "(source not available)";
      const msg = `Install tool "${tool.path}"?\n  Type: ${tool.toolType}\n  Source preview:\n${preview.substring(0, 500)}`;
      const ok = await confirm(msg);
      if (ok) {
        try {
          const content = await fetchRawFile(
            owner,
            repo,
            resolvedSha,
            tool.path,
            token,
          );
          const { mkdirSync, writeFileSync } = await import("node:fs");
          const { join } = await import("node:path");
          const destDir = join(
            process.cwd(),
            ".maxi",
            "imported",
            `${owner}-${repo}`,
            "tools",
          );
          mkdirSync(destDir, { recursive: true });
          writeFileSync(
            join(destDir, tool.path.split("/").pop()!),
            content,
            "utf-8",
          );
          installed.push(`tool:${tool.path}`);
        } catch (err) {
          declined.push(
            `tool:${tool.path} (error: ${(err as Error).message})`,
          );
        }
      } else {
        declined.push(`tool:${tool.path} (declined)`);
      }
    }
  }

  const summary = [
    `Installed: ${installed.length} (${installed.join(", ") || "none"})`,
    `Declined: ${declined.length} (${declined.join(", ") || "none"})`,
  ].join("\n");

  return {
    result: { success: true, output: summary },
    logEntry: {
      timestamp: new Date().toISOString(),
      action: "install",
      triggeredBy: "user",
      repo: `${owner}/${repo}`,
      ref: resolvedSha,
      details: `installed ${installed.length}, declined ${declined.length}`,
    },
  };
}