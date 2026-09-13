import { execFile, execSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { scrubEnv } from "./tools/env.js";

const execFileAsync = promisify(execFile);

function spawnAsync(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd: options.cwd, env: scrubEnv() });
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

/** Maximum number of snapshots to retain (FIFO eviction). */
const MAX_SNAPSHOTS = 20;

export interface SnapshotResult {
  success: boolean;
  message: string;
  hash?: string;
}

/**
 * Manages undo/redo snapshots via git refs (preferred) or filesystem copy (fallback).
 *
 * Git path: snapshots are committed to `refs/maxi/snapshots/<sessionId>`.
 * Non-git fallback: files are copied to `.maxi/snapshots/<sessionId>/<hash>/`.
 */
export class SnapshotManager {
  private cwd: string;
  private isGit: boolean;
  private sessionId: string;
  /** Stack of snapshot hashes (oldest → newest). */
  private history: string[] = [];
  /** Index into history[] pointing to the "current" snapshot. Undo decrements, redo increments. */
  private pointer = -1;
  /** Undone snapshot hashes (cleared on new snapshot). */
  private undone: string[] = [];

  constructor(cwd: string, sessionId: string) {
    this.cwd = cwd;
    this.sessionId = sessionId;
    this.isGit = this.detectGit();
  }

  // ── Public API ──────────────────────────────────────────────

  /** Save a snapshot of the current working tree. Returns the snapshot hash. */
  async saveSnapshot(): Promise<SnapshotResult> {
    if (this.isGit) {
      return this.saveGitSnapshot();
    }
    return this.saveFallbackSnapshot();
  }

  /** Undo: restore working tree to the previous snapshot. */
  async undo(): Promise<SnapshotResult> {
    if (this.history.length === 0) {
      return { success: false, message: "Nothing to undo — no snapshots saved yet." };
    }
    if (this.pointer <= 0) {
      return { success: false, message: "Already at the oldest snapshot." };
    }

    this.pointer--;
    const hash = this.history[this.pointer];

    if (this.isGit) {
      return this.restoreGitSnapshot(hash);
    }
    return this.restoreFallbackSnapshot(hash);
  }

  /** Redo: re-apply the most recently undone change. */
  async redo(): Promise<SnapshotResult> {
    if (this.undone.length === 0) {
      return { success: false, message: "Nothing to redo — no undone changes." };
    }
    if (this.pointer >= this.history.length - 1) {
      return { success: false, message: "Already at the newest snapshot." };
    }

    this.pointer++;
    const hash = this.history[this.pointer];

    if (this.isGit) {
      return this.restoreGitSnapshot(hash);
    }
    return this.restoreFallbackSnapshot(hash);
  }

  /** Check whether undo/redo operations are available. */
  canUndo(): boolean {
    return this.pointer > 0;
  }

  canRedo(): boolean {
    return this.undone.length > 0 && this.pointer < this.history.length - 1;
  }

  // ── Git path ────────────────────────────────────────────────

  private async saveGitSnapshot(): Promise<SnapshotResult> {
    try {
      // Stage everything (including untracked files)
      await execFileAsync("git", ["add", "-A"], { cwd: this.cwd, env: scrubEnv() });

      // Check if there's anything to commit
      const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], { cwd: this.cwd, env: scrubEnv() });
      if (!status.trim()) {
        return { success: true, message: "No changes to snapshot (working tree clean)." };
      }

      // Detect HEAD for drift detection
      const { stdout: headHash } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: this.cwd, env: scrubEnv() });
      const meta = { headAtSave: headHash.trim(), timestamp: Date.now() };

      // Commit to the snapshot ref
      const refName = `refs/maxi/snapshots/${this.sessionId}`;
      const message = `maxi snapshot ${Date.now()}\n\n${JSON.stringify(meta)}`;
      await spawnAsync(
        "git",
        ["commit", "--allow-empty", "-F", "-"],
        { cwd: this.cwd, input: message }
      );

      // Get the commit hash
      const { stdout: commitHash } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: this.cwd, env: scrubEnv() });
      const hash = commitHash.trim();

      // Move the ref to point here (doesn't touch HEAD)
      await execFileAsync("git", ["update-ref", refName, hash], { cwd: this.cwd, env: scrubEnv() });

      // Reset HEAD back to where it was
      await execFileAsync("git", ["reset", headHash.trim()], { cwd: this.cwd, env: scrubEnv() });

      this.recordSnapshot(hash);
      return { success: true, message: `Snapshot saved (${hash.slice(0, 8)})`, hash };
    } catch (err) {
      return { success: false, message: `Snapshot failed: ${(err as Error).message}` };
    }
  }

  private async restoreGitSnapshot(hash: string): Promise<SnapshotResult> {
    try {
      // Restore the working tree from the snapshot commit
      await execFileAsync("git", ["checkout", hash, "--", "."], { cwd: this.cwd, env: scrubEnv() });
      return { success: true, message: `Restored snapshot ${hash.slice(0, 8)}` };
    } catch (err) {
      return { success: false, message: `Restore failed: ${(err as Error).message}` };
    }
  }

  // ── Non-git fallback path ───────────────────────────────────

  private getSnapshotDir(): string {
    return join(this.cwd, ".maxi", "snapshots", this.sessionId);
  }

  private async saveFallbackSnapshot(): Promise<SnapshotResult> {
    try {
      const dir = this.getSnapshotDir();
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const hash = `snap-${Date.now()}`;
      const dest = join(dir, hash);
      mkdirSync(dest, { recursive: true });

      // Copy common source directories/files
      const targets = ["src", "lib", "index.ts", "index.js", "package.json"];
      for (const t of targets) {
        const src = join(this.cwd, t);
        if (existsSync(src)) {
          cpSync(src, join(dest, t), { recursive: true });
        }
      }

      this.recordSnapshot(hash);
      return { success: true, message: `Snapshot saved (${hash})`, hash };
    } catch (err) {
      return { success: false, message: `Snapshot failed: ${(err as Error).message}` };
    }
  }

  private async restoreFallbackSnapshot(hash: string): Promise<SnapshotResult> {
    try {
      const dir = this.getSnapshotDir();
      const src = join(dir, hash);
      if (!existsSync(src)) {
        return { success: false, message: `Snapshot ${hash} not found on disk.` };
      }

      // Restore by copying back
      const entries = ["src", "lib", "index.ts", "index.js", "package.json"];
      for (const e of entries) {
        const snapshotPath = join(src, e);
        if (existsSync(snapshotPath)) {
          const dest = join(this.cwd, e);
          rmSync(dest, { recursive: true, force: true });
          cpSync(snapshotPath, dest, { recursive: true });
        }
      }

      return { success: true, message: `Restored snapshot ${hash}` };
    } catch (err) {
      return { success: false, message: `Restore failed: ${(err as Error).message}` };
    }
  }

  // ── Helpers ─────────────────────────────────────────────────

  private detectGit(): boolean {
    try {
      execSync("git rev-parse --is-inside-work-tree", {
        cwd: this.cwd,
        stdio: "ignore",
        env: scrubEnv(),
      });
      return true;
    } catch {
      return false;
    }
  }

  private recordSnapshot(hash: string): void {
    // If we undid and now save a new snapshot, drop the "future" entries
    if (this.pointer < this.history.length - 1) {
      this.history = this.history.slice(0, this.pointer + 1);
      this.undone = [];
    }

    this.history.push(hash);
    this.pointer = this.history.length - 1;

    // FIFO eviction
    if (this.history.length > MAX_SNAPSHOTS) {
      const removed = this.history.shift()!;
      this.pointer--;
      // Clean up filesystem for evicted snapshot
      if (this.isGit) {
        // Git refs are lightweight, no cleanup needed
      } else {
        try {
          const dir = join(this.getSnapshotDir(), removed);
          if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
        } catch { /* non-fatal */ }
      }
    }
  }
}
