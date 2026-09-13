/**
 * Phase 4.3 — Cost / turn governor.
 *
 * Enforces configurable ceilings on a session: wall-clock time, total tool
 * calls, and estimated tokens. `checkToolCall` is called BEFORE each tool
 * execution; on breach it returns `{ ok: false, reason }` and the session
 * enters the `blocked` state. A blocked session requires explicit user
 * re-authorization (`/continue` in the REPL) which resets the counters.
 *
 * Token accounting: when provider usage metadata is absent, tokens are
 * estimated as `chars / 4` at the call site via `recordTokens`.
 */

export interface GovernorOptions {
  /** Max unattended wall-clock ms from construction. Defaults to 30 min. */
  maxWallClockMs?: number;
  /** Max tool calls. Defaults to 100. */
  maxToolCalls?: number;
  /** Max estimated tokens. Defaults to 500_000. */
  maxTokens?: number;
  /** Called once when a ceiling is breached. */
  onBreach?: (info: { reason: string; elapsedMs: number; toolCalls: number; tokens: number }) => void;
}

export type GovernorState = "ok" | "blocked";

export type ToolCallCheck = { ok: true } | { ok: false; reason: string };

const DEFAULT_WALL_CLOCK_MS = 30 * 60 * 1000;
const DEFAULT_MAX_TOOL_CALLS = 100;
const DEFAULT_MAX_TOKENS = 500_000;

export class SessionGovernor {
  private readonly maxWallClockMs: number;
  private readonly maxToolCalls: number;
  private readonly maxTokens: number;
  private readonly onBreach?: GovernorOptions["onBreach"];
  private startedAt: number;
  private toolCalls = 0;
  private tokens = 0;
  private blocked = false;
  private lastReason = "";

  constructor(opts: GovernorOptions = {}) {
    this.maxWallClockMs = opts.maxWallClockMs ?? DEFAULT_WALL_CLOCK_MS;
    this.maxToolCalls = opts.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.onBreach = opts.onBreach;
    this.startedAt = Date.now();
  }

  /**
   * Check whether a tool call may proceed. Returns `{ ok: true }` when under
   * every ceiling; otherwise marks the session blocked and returns the reason.
   */
  checkToolCall(): ToolCallCheck {
    if (this.blocked) {
      return { ok: false, reason: this.lastReason };
    }

    const elapsedMs = Date.now() - this.startedAt;
    if (elapsedMs >= this.maxWallClockMs) {
      return this.breach(`wall-clock ceiling (${Math.round(elapsedMs / 1000)}s elapsed)`);
    }
    if (this.toolCalls >= this.maxToolCalls) {
      return this.breach(`tool-call ceiling (${this.maxToolCalls} calls)`);
    }
    if (this.tokens >= this.maxTokens) {
      return this.breach(`token ceiling (${this.tokens} tokens)`);
    }

    this.toolCalls += 1;
    return { ok: true };
  }

  /** Record estimated tokens (chars/4) when provider usage metadata is absent. */
  recordTokens(n: number): void {
    this.tokens += n;
  }

  /** Current governor state. */
  state(): GovernorState {
    return this.blocked ? "blocked" : "ok";
  }

  /** Explicit user re-authorization: reset wall-clock and counters. */
  reset(): void {
    this.blocked = false;
    this.lastReason = "";
    this.toolCalls = 0;
    this.tokens = 0;
    this.startedAt = Date.now();
  }

  private breach(reason: string): { ok: false; reason: string } {
    this.blocked = true;
    this.lastReason = reason;
    this.onBreach?.({
      reason,
      elapsedMs: Date.now() - this.startedAt,
      toolCalls: this.toolCalls,
      tokens: this.tokens,
    });
    return { ok: false, reason };
  }
}
