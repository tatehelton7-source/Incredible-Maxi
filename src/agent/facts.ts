/**
 * Phase 6 — Provenance-tagged facts memory.
 *
 * No vector DB, no embeddings. Facts are high-signal user corrections (and
 * future inferred entries) persisted as a flat JSON array at `<cwd>/.maxi/facts.json`.
 *
 * DESIGN NOTE — structured writes only (Phase-appropriate):
 *   In this phase, only the explicit API (FactStore methods + REPL /fact commands)
 *   writes facts. The model NEVER auto-generates 'inferred' facts; it can suggest
 *   corrections that the user then explicitly adds. Automatic inferred writes are
 *   reserved for a future phase where a gate or approval step validates them.
 *
 * STORAGE FORMAT:
 *   { id: string; fact: string; source: 'user-correction' | 'inferred'; sessionId?: string; ts: number }
 *   Sequential ids: fact-1, fact-2, ...
 *
 * DEDUP:
 *   Exact trimmed-lowercase match on `fact` bumps `ts` and keeps the existing
 *   id. Source preference: 'user-correction' wins over 'inferred' (never
 *   downgrades provenance).
 *
 * CAPS:
 *   30 facts max, 1200 chars total when rendered. Oldest facts are truncated
 *   first when the cap is exceeded.
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Fact {
  id: string;
  fact: string;
  source: "user-correction" | "inferred";
  sessionId?: string;
  ts: number;
}

const MAX_FACTS = 30;
const MAX_CHARS = 1200;

// ── Pure core ────────────────────────────────────────────────────────────────

/** Normalise a fact string for dedup comparison (trimmed, lowercased). */
function normalizeFact(fact: string): string {
  return fact.trim().toLowerCase();
}

/**
 * Add a fact to an in-memory array, enforcing dedup and caps.
 * Returns the updated array (a new reference; the original is not mutated).
 */
export function addFact(
  facts: readonly Fact[],
  fact: string,
  source: Fact["source"],
  sessionId?: string,
  nextId?: number,
): { facts: Fact[]; id: string; dedup: boolean } {
  const trimmed = fact.trim();
  if (!trimmed) return { facts: [...facts], id: "", dedup: false };

  const norm = normalizeFact(trimmed);
  const existingIdx = facts.findIndex((f) => normalizeFact(f.fact) === norm);

  if (existingIdx >= 0) {
    const existing = facts[existingIdx];
    // Source preference: 'user-correction' wins (never downgrades)
    const newSource: Fact["source"] =
      source === "user-correction" || existing.source === "user-correction"
        ? "user-correction"
        : "inferred";
    const updated: Fact = {
      ...existing,
      source: newSource,
      ts: Date.now(),
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
    const copy = [...facts];
    copy[existingIdx] = updated;
    return { facts: copy, id: existing.id, dedup: true };
  }

  const id = `fact-${nextId ?? facts.length + 1}`;
  const entry: Fact = {
    id,
    fact: trimmed,
    source,
    ts: Date.now(),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
  const updated = [...facts, entry];
  // Enforce cap: drop oldest (lowest ts) first
  while (updated.length > MAX_FACTS) {
    let oldestIdx = 0;
    for (let i = 1; i < updated.length; i++) {
      if (updated[i].ts < updated[oldestIdx].ts) oldestIdx = i;
    }
    updated.splice(oldestIdx, 1);
  }
  return { facts: updated, id, dedup: false };
}

/**
 * Remove a fact by its id. Returns the updated array.
 */
export function removeFact(facts: readonly Fact[], id: string): Fact[] {
  return facts.filter((f) => f.id !== id);
}

/**
 * Render facts into a frozen-prefix section. Caps at MAX_FACTS entries and
 * MAX_CHARS total characters. Oldest facts are truncated first.
 * Returns the rendered string (empty if no facts).
 */
export function renderFactsSection(facts: readonly Fact[]): string {
  if (facts.length === 0) return "";

  // Sort oldest first (lowest ts first)
  const sorted = [...facts].sort((a, b) => a.ts - b.ts);

  let charCount = 0;
  const lines: string[] = [];

  for (const f of sorted) {
    const line = `- ${f.fact}`;
    if (lines.length >= MAX_FACTS) break;
    if (charCount + line.length > MAX_CHARS && lines.length > 0) break;
    lines.push(line);
    charCount += line.length;
  }

  if (lines.length === 0) return "";
  return `## Project facts\n${lines.join("\n")}`;
}

// ── Thin fs wrapper ──────────────────────────────────────────────────────────

export class FactStore {
  private facts: Fact[] = [];
  private nextId: number;
  private readonly filePath: string;

  constructor(cwd: string) {
    this.filePath = join(cwd, ".maxi", "facts.json");
    this.nextId = 1;
  }

  /** Load facts from disk. Missing or corrupt file → treat as empty. */
  async load(): Promise<void> {
    try {
      if (!existsSync(this.filePath)) {
        this.facts = [];
        return;
      }
      const raw = await readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        this.facts = [];
        return;
      }
      this.facts = parsed;
      // Compute nextId from max existing id
      let maxId = 0;
      for (const f of this.facts) {
        const match = f.id?.match(/^fact-(\d+)$/);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > maxId) maxId = num;
        }
      }
      this.nextId = maxId + 1;
    } catch {
      this.facts = [];
    }
  }

  /** Save facts to disk atomically (write tmp + rename). */
  async save(): Promise<void> {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    const tmpPath = this.filePath + ".tmp";
    await writeFile(tmpPath, JSON.stringify(this.facts, null, 2), "utf-8");
    await rename(tmpPath, this.filePath);
  }

  /** List all facts (read-only copy). */
  list(): readonly Fact[] {
    return this.facts;
  }

  /** Add a fact (with dedup). Persists to disk. Returns the id and whether it was a dedup. */
  async add(fact: string, source: Fact["source"], sessionId?: string): Promise<{ id: string; dedup: boolean }> {
    const result = addFact(this.facts, fact, source, sessionId, this.nextId);
    this.facts = result.facts;
    if (!result.dedup) this.nextId += 1;
    await this.save();
    return { id: result.id, dedup: result.dedup };
  }

  /** Remove a fact by id. Persists to disk. */
  async remove(id: string): Promise<boolean> {
    const before = this.facts.length;
    this.facts = removeFact(this.facts, id);
    if (this.facts.length === before) return false;
    await this.save();
    return true;
  }

  /** Render the frozen-prefix section. */
  renderSection(): string {
    return renderFactsSection(this.facts);
  }
}
