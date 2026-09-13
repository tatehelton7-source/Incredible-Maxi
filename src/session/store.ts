/**
 * Phase 2 — Durable, resumable sessions.
 *
 * Sessions are stored as append-only JSONL at `~/.maxi/sessions/<id>.jsonl`.
 * One JSON object per line, each an immutable `SessionEvent`. Because the log
 * is append-only, "checkpointing" is just ensuring each append is awaited
 * before the next event is produced — there is no mutable state to flush.
 * Callers MUST await `append` (never fire-and-forget) so that a SIGINT/SIGTERM
 * or process exit leaves the log consistent up to the last completed event.
 *
 * Idempotency: every `tool-call` event carries a `callId` (crypto.randomUUID).
 * A call is "complete" iff a matching `tool-result` event exists. On resume,
 * `getInterruptedCall` finds the most recent tool-call lacking a result; the
 * caller decides via `resolveInterruptedCall` whether to re-run (read-only
 * tools) or skip (side-effecting tools) — never double-execute a side effect,
 * never silently mark an interrupted call complete.
 *
 * Permissions: the session dir is created 0o700 and files 0o600 on POSIX.
 * On Windows these modes are ignored by the OS (ACL-based), so they are a
 * quiet no-op there.
 *
 * Additive change (Phase 4.2 sandbox layer): the `SessionEvent` union gained a
 * `sandbox-denial` variant. This is purely additive — existing events are
 * unchanged and `FORMAT_VERSION` stays "1". Older readers that do not know the
 * variant simply ignore it; newer readers treat it as an audit record for a
 * sandboxed execution that was denied (path-confinement, network-allowlist,
 * resource-limit, or config-guard). Denials are logged here, in the session
 * JSONL, and are NOT written to any separate audit file.
 */

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TOOL_CATEGORIES, type ApprovalDecision } from "../tools/approval.js";
import type { PlanStepStatus } from "../agent/plan.js";

/** The on-disk format version, written as the first event of every session. */
export const FORMAT_VERSION = "1";

/**
 * A single immutable session event. Every event carries a monotonically
 * increasing `seq` (its line index), a timestamp, and the owning session id.
 */
export type SessionEvent = { seq: number; ts: number; sessionId: string } & (
  | { type: "user-message"; text: string }
  | { type: "assistant-message"; text: string }
  | { type: "tool-call"; callId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool-result"; callId: string; ok: boolean; output: string }
  | {
      type: "approval-decision";
      toolName: string;
      decision: ApprovalDecision;
      rule: string;
      target?: string;
      callId?: string;
    }
  | { type: "snapshot"; snapshotId: string }
  | { type: "session-meta"; key: string; value: string }
  | { type: "plan-created"; goal: string; stepCount: number; planId: string }
  | { type: "plan-updated"; planId: string; revision: number }
  | { type: "plan-advanced"; planId: string; stepId: string; to: PlanStepStatus }
  | { type: "plan-rewritten"; oldPlanId: string; newPlanId: string; carriedVerified: number }
  | {
      type: "sandbox-denial";
      stepId: string;
      layer: string;
      detail: string;
    }
);

/** The subset of fields a caller supplies when appending (seq/ts/sessionId are derived). */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type SessionEventInput = DistributiveOmit<SessionEvent, "seq" | "ts" | "sessionId">;

/** How an interrupted tool call should be handled on resume. */
export type InterruptResolution = "rerun" | "skip";

/**
 * Append-only JSONL session store. Each session is one file; events are
 * appended one JSON object per line. Reads reconstruct the full event array.
 */
export class SessionStore {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? join(homedir(), ".maxi", "sessions");
  }

  private path(id: string): string {
    return join(this.dir, `${id}.jsonl`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  private ensureDirSync(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  /** Create a new session, writing the format-version header line. Returns the new id. */
  async createSession(): Promise<string> {
    const id = randomUUID();
    await this.append(id, {
      type: "session-meta",
      key: "formatVersion",
      value: FORMAT_VERSION,
    });
    return id;
  }

  /** Append one event. Awaited by callers so the log stays consistent on exit. */
  async append(sessionId: string, event: SessionEventInput): Promise<void> {
    await this.ensureDir();
    const events = await this.readAll(sessionId);
    const full: SessionEvent = { ...event, seq: events.length, ts: Date.now(), sessionId };
    await appendFile(this.path(sessionId), JSON.stringify(full) + "\n", "utf-8");
  }

  /**
   * Synchronous append, used by the ApprovalLog sink (which is synchronous).
   * Keeps the "no fire-and-forget" guarantee for approval decisions too.
   */
  appendSync(sessionId: string, event: SessionEventInput): void {
    this.ensureDirSync();
    const events = this.readAllSync(sessionId);
    const full: SessionEvent = { ...event, seq: events.length, ts: Date.now(), sessionId };
    appendFileSync(this.path(sessionId), JSON.stringify(full) + "\n", "utf-8");
  }

  /** Read all events for a session, in order. Returns [] if the session does not exist. */
  async readAll(sessionId: string): Promise<SessionEvent[]> {
    try {
      const raw = await readFile(this.path(sessionId), "utf-8");
      return parseLines(raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  private readAllSync(sessionId: string): SessionEvent[] {
    try {
      const raw = readFileSync(this.path(sessionId), "utf-8");
      return parseLines(raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  /** List all session ids present on disk. */
  async list(): Promise<string[]> {
    await this.ensureDir();
    const files = await readdir(this.dir);
    return files.filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -".jsonl".length));
  }

  /**
   * Branch a session: copy events seq 0..boundary-1 (default: all) into a new
   * file with a fresh session id, then append a `forkedFrom` marker. Returns
   * the new session id.
   */
  async fork(sessionId: string, newSeqBoundary?: number): Promise<string> {
    const events = await this.readAll(sessionId);
    const boundary = newSeqBoundary ?? events.length;
    const newId = randomUUID();
    await this.ensureDir();

    const lines: string[] = [];
    for (const ev of events.slice(0, boundary)) {
      lines.push(JSON.stringify({ ...ev, sessionId: newId }) + "\n");
    }
    const marker: SessionEvent = {
      seq: boundary,
      ts: Date.now(),
      sessionId: newId,
      type: "session-meta",
      key: "forkedFrom",
      value: sessionId,
    };
    lines.push(JSON.stringify(marker) + "\n");

    await writeFile(this.path(newId), lines.join(""), { encoding: "utf-8", mode: 0o600 });
    return newId;
  }
}

function parseLines(raw: string): SessionEvent[] {
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as SessionEvent);
}

/**
 * Find the most recent tool-call that has no matching tool-result — i.e. the
 * call that was interrupted mid-execution. Returns null when every tool-call
 * is complete.
 */
export function getInterruptedCall(events: SessionEvent[]): SessionEvent | null {
  const completed = new Set<string>();
  for (const ev of events) {
    if (ev.type === "tool-result") completed.add(ev.callId);
  }
  let interrupted: SessionEvent | null = null;
  for (const ev of events) {
    if (ev.type === "tool-call" && !completed.has(ev.callId)) {
      interrupted = ev;
    }
  }
  return interrupted;
}

/**
 * Decide how an interrupted tool call should be handled on resume.
 * Read-only tools are safe to re-run; everything else (shell, file-write,
 * git-push, network, unknown) is side-effecting and must NOT be re-executed.
 */
export function resolveInterruptedCall(event: SessionEvent): InterruptResolution {
  if (event.type !== "tool-call") return "skip";
  const category = TOOL_CATEGORIES[event.toolName] ?? "shell";
  return category === "read-only" ? "rerun" : "skip";
}

/**
 * Rebuild the conversational history (user/assistant texts only) from a
 * session's events. Tool calls and results are not part of the visible
 * history — they are replayed separately for idempotency.
 */
export function reconstructHistory(
  events: SessionEvent[]
): Array<{ role: "user" | "assistant"; content: string }> {
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const ev of events) {
    if (ev.type === "user-message") history.push({ role: "user", content: ev.text });
    else if (ev.type === "assistant-message") history.push({ role: "assistant", content: ev.text });
  }
  return history;
}
