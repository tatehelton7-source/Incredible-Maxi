import { readdir, stat, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";

interface FileEntry {
  path: string;
  size: number;
  extension: string;
  modified: number;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", ".build", "__pycache__", ".cache"]);
const MAX_FILE_SIZE = 1024 * 1024;
const CHARS_PER_TOKEN = 4;

export class ContextEngine {
  private cwd: string;
  private files: FileEntry[] = [];
  private indexed = false;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  async indexCodebase(): Promise<void> {
    this.files = [];
    await this.walk(this.cwd);
    this.files.sort((a, b) => b.modified - a.modified);
    this.indexed = true;
  }

  private async walk(dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    const entries = await readdir(dir);
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const fullPath = join(dir, entry);
      const s = await stat(fullPath);
      if (s.isDirectory()) {
        await this.walk(fullPath);
      } else if (s.size < MAX_FILE_SIZE) {
        this.files.push({
          path: relative(this.cwd, fullPath),
          size: s.size,
          extension: extname(entry),
          modified: s.mtimeMs,
        });
      }
    }
  }

  getFileTree(): string {
    if (!this.indexed) return "(codebase not indexed — call indexCodebase() first)";
    const byDir = new Map<string, FileEntry[]>();
    for (const file of this.files) {
      const dir = file.path.includes("/") ? file.path.substring(0, file.path.lastIndexOf("/")) : ".";
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir)!.push(file);
    }
    const lines: string[] = [];
    for (const [dir, files] of [...byDir.entries()].sort()) {
      lines.push(`${dir}/`);
      for (const file of files) {
        lines.push(`  ${basename(file.path)} (${this.formatSize(file.size)})`);
      }
    }
    return lines.join("\n");
  }

  async getContextForPrompt(prompt: string, maxTokens: number): Promise<string> {
    if (!this.indexed) await this.indexCodebase();

    const maxChars = maxTokens * CHARS_PER_TOKEN;
    const parts: string[] = [];

    const tree = this.getFileTree();
    parts.push("# Project Structure\n```\n" + tree + "\n```");

    const keywords = this.extractKeywords(prompt);
    const matchingFiles = this.files.filter((f) =>
      keywords.some((kw) => f.path.toLowerCase().includes(kw.toLowerCase()))
    );

    const filesToInclude = [...matchingFiles, ...this.files.filter((f) => !matchingFiles.includes(f))];

    let usedChars = parts.join("\n").length;
    for (const file of filesToInclude) {
      if (usedChars >= maxChars) break;
      try {
        const content = await readFile(join(this.cwd, file.path), "utf-8");
        const fileSection = `\n\n# ${file.path}\n\`\`\`\n${content}\n\`\`\`\n`;
        if (usedChars + fileSection.length > maxChars) {
          const remaining = maxChars - usedChars;
          if (remaining > 200) {
            parts.push(`\n\n# ${file.path} (truncated)\n\`\`\`\n${content.substring(0, remaining - 50)}...\n\`\`\`\n`);
            usedChars = maxChars;
          }
          break;
        }
        parts.push(fileSection);
        usedChars += fileSection.length;
      } catch {
        continue;
      }
    }

    return parts.join("\n");
  }

  async addFile(path: string): Promise<void> {
    const fullPath = join(this.cwd, path);
    if (!existsSync(fullPath)) return;
    const s = await stat(fullPath);
    if (!this.indexed) this.indexed = true;
    const existing = this.files.findIndex((f) => f.path === path);
    if (existing >= 0) {
      this.files[existing] = {
        path,
        size: s.size,
        extension: extname(path),
        modified: s.mtimeMs,
      };
    } else {
      this.files.push({
        path,
        size: s.size,
        extension: extname(path),
        modified: s.mtimeMs,
      });
    }
  }

  clear(): void {
    this.files = [];
    this.indexed = false;
  }

  getFileCount(): number {
    return this.files.length;
  }

  private extractKeywords(prompt: string): string[] {
    const stopWords = new Set(["the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do", "does", "did", "will", "would", "could", "should", "may", "might", "must", "can", "this", "that", "these", "those", "i", "you", "he", "she", "it", "we", "they", "what", "which", "who", "when", "where", "why", "how", "all", "each", "every", "both", "few", "more", "most", "other", "some", "such", "no", "nor", "not", "only", "own", "same", "so", "than", "too", "very", "just", "in", "on", "at", "to", "for", "of", "with", "by", "from", "about", "as", "into", "through", "during", "before", "after", "above", "below", "up", "down", "out", "off", "over", "under", "again", "further", "then", "once", "and", "but", "or", "if", "because", "while", "my", "your", "his", "her", "its", "our", "their"]);
    return prompt
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
}
