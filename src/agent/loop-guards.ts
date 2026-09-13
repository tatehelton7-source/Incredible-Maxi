/**
 * Phase 3.4 — Retry budget + stall detection.
 *
 * Tracks tool-execution failures to (a) detect a stall — the same command
 * failing twice consecutively with the same normalized error signature — and
 * (b) enforce a per-step attempt cap. The tracker is keyed by `toolName:target`
 * for stall detection and by step id for the retry budget.
 */

/** Normalize an error output into a stable signature: first 200 chars, whitespace-collapsed, digits masked. */
export function normalizeSignature(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim().slice(0, 200);
  return collapsed.replace(/\d/g, "#");
}

interface FailureEntry {
  count: number;
  lastSignature?: string;
  prevSignature?: string;
}

export class ToolFailureTracker {
  private failures = new Map<string, FailureEntry>();
  private stepAttempts = new Map<string, number>();
  private currentStepId: string | undefined;

  /** Set the step whose attempt count subsequent failures should increment. */
  setCurrentStep(stepId: string | undefined): void {
    this.currentStepId = stepId;
  }

  recordFailure(toolName: string, target: string, signature: string): void {
    const key = `${toolName}:${target}`;
    const entry = this.failures.get(key) ?? { count: 0 };
    entry.prevSignature = entry.lastSignature;
    entry.lastSignature = signature;
    entry.count += 1;
    this.failures.set(key, entry);
    if (this.currentStepId) {
      this.stepAttempts.set(this.currentStepId, (this.stepAttempts.get(this.currentStepId) ?? 0) + 1);
    }
  }

  /** True when the same command has failed twice consecutively with the same signature. */
  isStalled(toolName: string, target: string, signature: string): boolean {
    const entry = this.failures.get(`${toolName}:${target}`);
    if (!entry) return false;
    return entry.count >= 2 && entry.lastSignature === signature && entry.prevSignature === signature;
  }

  /** Number of recorded failures for a step (defaults to the current step). */
  attemptsFor(currentStepId?: string): number {
    const id = currentStepId ?? this.currentStepId;
    if (!id) return 0;
    return this.stepAttempts.get(id) ?? 0;
  }
}
