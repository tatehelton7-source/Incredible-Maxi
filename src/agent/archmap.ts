/**
 * Phase 6 — Architecture map (architecture.md).
 *
 * A curated, size-capped project map that lives at `<cwd>/.maxi/architecture.md`.
 * The model writes through a dedicated `architecture_update` tool (approval-gated
 * as file-write), NOT through writeFile directly — this ensures the validation
 * gate (≤200 lines, starts with '# ') is always applied.
 *
 * VALIDATION RULES:
 *   1. Content must be valid UTF-8 text.
 *   2. First line must start with '# ' (Markdown heading).
 *   3. Content must be ≤ 200 lines.
 *   If validation fails, the write is rejected with an error message telling the
 *   model to prune its architecture map.
 *
 * FROZEN PREFIX:
 *   If architecture.md exists, it renders into the stable prefix region as a
 *   `## Architecture map` section, capped at 4000 characters.
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const MAX_LINES = 200;
const MAX_PREFIX_CHARS = 4000;

export function archmapPath(cwd: string): string {
  return join(cwd, ".maxi", "architecture.md");
}

/**
 * Validate architecture.md content. Returns null on success, error message on failure.
 */
export function validateArchMap(content: string): string | null {
  if (!Buffer.from(content, "utf-8")) {
    return "Error: content must be valid UTF-8 text";
  }
  const lines = content.split("\n");
  if (lines.length === 0 || !lines[0].startsWith("# ")) {
    return "Error: first line must start with '# ' (Markdown heading). Please start with a project title heading.";
  }
  if (lines.length > MAX_LINES) {
    return `Error: architecture map must be ≤ ${MAX_LINES} lines (got ${lines.length}). Please prune the content.`;
  }
  return null;
}

/**
 * Read the architecture map from disk. Returns null if it doesn't exist or
 * can't be read.
 */
export async function readArchMap(cwd: string): Promise<string | null> {
  const path = archmapPath(cwd);
  try {
    if (!existsSync(path)) return null;
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Write the architecture map to disk after validation. Returns a discriminated
 * result: `{ ok: true }` on success, or `{ ok: false; error: string }` with a
 * clear message telling the caller to prune when validation fails.
 */
export async function updateArchMap(
  cwd: string,
  content: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const validationError = validateArchMap(content);
  if (validationError) return { ok: false, error: validationError };

  const path = archmapPath(cwd);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  const tmpPath = path + ".tmp";
  await writeFile(tmpPath, content, "utf-8");
  await rename(tmpPath, path);
  return { ok: true };
}

/**
 * Render the architecture map into a frozen-prefix section. Capped at 4000 chars.
 * Returns empty string if content is null.
 */
export function renderArchMapSection(content: string | null): string {
  if (!content) return "";
  const truncated = content.length > MAX_PREFIX_CHARS
    ? content.slice(0, MAX_PREFIX_CHARS) + "\n<!-- truncated -->"
    : content;
  return `## Architecture map\n${truncated}`;
}
