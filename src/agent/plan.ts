/**
 * Phase 3.1 — Plan artifact.
 *
 * Working memory is shared *state*, not forced narration. The model mutates a
 * durable Plan via explicit tools (`plan_update`, `plan_advance`) instead of
 * narrating its next step in prose. This module is pure and in-memory for the
 * REPL session; persistence is deferred to Phase 3.3.
 */

export type PlanStepStatus = "pending" | "in-progress" | "blocked" | "verified" | "failed";

export interface PlanStep {
  id: string;
  description: string;
  status: PlanStepStatus;
  /** Shell command whose exit 0 is the only path to `verified` (Phase 4). */
  gate?: string;
  /** Snapshot pointer written when a gate passes (Phase 4). */
  snapshotId?: string;
  attempts: number;
  lastError?: string;
  /** Paths (relative to project root) this step declares it will write (Phase 4.2). */
  declaredWrites?: string[];
  /** Network domains this step declares it needs (Phase 4.2). */
  network?: { domains: string[] };
}

export interface Plan {
  /** Stable, monotonically increasing id (`plan-1`, `plan-2`, ...). */
  id: string;
  goal: string;
  steps: PlanStep[];
  revision: number;
  /** Id of the plan that superseded this one (set on rewrite). */
  supersededBy?: string;
}

export type AdvanceResult = { ok: true; step: PlanStep } | { ok: false; error: string };

/**
 * Result of running a step's gate command (Phase 4.1). `snapshotId` is set by
 * the caller when a passing gate also produced a snapshot; the store writes it
 * onto the step so the verified step carries its snapshot pointer.
 */
export interface GateRunResult {
  exitCode: number;
  output: string;
  snapshotId?: string;
}

/** A step description as accepted by `create`/`update` — plain string or with a gate. */
export type StepInput =
  | string
  | {
      description: string;
      gate?: string;
      declaredWrites?: string[];
      network?: { domains: string[] };
    };

/** ASCII status glyphs — terminal-safe (no unicode box-drawing). */
const STATUS_GLYPH: Record<PlanStepStatus, string> = {
  pending: "[ ]",
  "in-progress": "[>]",
  blocked: "[!]",
  verified: "[x]",
  failed: "[X]",
};

let stepCounter = 0;
function nextStepId(): string {
  stepCounter += 1;
  return `step-${stepCounter}`;
}

/**
 * In-memory plan store for a single REPL session. Holds the current plan plus
 * a history of superseded plans (kept retrievable for the Time Machine).
 */
export class PlanStore {
  private current: Plan | undefined;
  private history: Plan[] = [];
  private nextPlanId = 1;

  /** Create a plan from a goal and step descriptions. Replaces any current plan. */
  create(goal: string, stepInputs: StepInput[]): Plan {
    const plan: Plan = {
      id: `plan-${this.nextPlanId}`,
      goal,
      steps: stepInputs.map((input) => {
        const description = typeof input === "string" ? input : input.description;
        const gate = typeof input === "string" ? undefined : input.gate;
        const declaredWrites = typeof input === "string" ? undefined : input.declaredWrites;
        const network = typeof input === "string" ? undefined : input.network;
        return {
          id: nextStepId(),
          description,
          status: "pending",
          attempts: 0,
          ...(gate ? { gate } : {}),
          ...(declaredWrites && declaredWrites.length > 0 ? { declaredWrites } : {}),
          ...(network ? { network } : {}),
        };
      }),
      revision: 1,
    };
    this.nextPlanId += 1;
    this.current = plan;
    return plan;
  }

  /** The current plan, or undefined if none has been created. */
  get(): Plan | undefined {
    return this.current;
  }

  /** Plans that have been superseded by a rewrite, oldest first. */
  historyPlans(): readonly Plan[] {
    return this.history;
  }

  /**
   * Replace the step list and update the goal. Increments the revision.
   * Returns undefined when no plan exists yet.
   */
  update(goal: string, steps: PlanStep[]): Plan | undefined {
    if (!this.current) return undefined;
    this.current = { ...this.current, goal, steps, revision: this.current.revision + 1 };
    return this.current;
  }

  /**
   * Advance a step to its next natural status:
   *   pending → in-progress (only if no other step is in-progress)
   *   in-progress → verified (only if the step has no `gate`; a gated step is
   *     rejected — use `advanceWithGate` to run its gate)
   */
  advance(stepId: string): AdvanceResult {
    const step = this.findStep(stepId);
    if (!step) return { ok: false, error: `No step with id "${stepId}"` };

    if (step.status === "pending") {
      const alreadyInProgress = this.current!.steps.some((s) => s.status === "in-progress");
      if (alreadyInProgress) {
        return { ok: false, error: "Another step is already in-progress; finish it first" };
      }
      return this.mutateStep(step, { status: "in-progress" });
    }

    if (step.status === "in-progress") {
      if (step.gate) {
        return {
          ok: false,
          error: `Step "${stepId}" has a gate; verification requires running the gate`,
        };
      }
      return this.mutateStep(step, { status: "verified" });
    }

    return { ok: false, error: `Step "${stepId}" is ${step.status} and cannot advance` };
  }

  /**
   * Advance a step, running its gate when present. A gated in-progress step
   * reaches `verified` only when `runGate` reports exit 0; on failure it stays
   * in-progress with `lastError` set. A passing gate's `snapshotId` (if any) is
   * written onto the step. Pending steps transition to in-progress without
   * running the gate, matching `advance`.
   */
  async advanceWithGate(
    stepId: string,
    runGate: (command: string) => Promise<GateRunResult>
  ): Promise<AdvanceResult> {
    const step = this.findStep(stepId);
    if (!step) return { ok: false, error: `No step with id "${stepId}"` };

    if (step.status === "pending") {
      const alreadyInProgress = this.current!.steps.some((s) => s.status === "in-progress");
      if (alreadyInProgress) {
        return { ok: false, error: "Another step is already in-progress; finish it first" };
      }
      return this.mutateStep(step, { status: "in-progress" });
    }

    if (step.status === "in-progress") {
      if (!step.gate) {
        return this.mutateStep(step, { status: "verified" });
      }
      const { exitCode, output, snapshotId } = await runGate(step.gate);
      if (exitCode === 0) {
        return this.mutateStep(step, {
          status: "verified",
          ...(snapshotId ? { snapshotId } : {}),
        });
      }
      return this.mutateStep(step, { lastError: `Gate failed (exit ${exitCode}): ${output}` });
    }

    return { ok: false, error: `Step "${stepId}" is ${step.status} and cannot advance` };
  }

  /** Mark a step blocked (any status) with a reason. */
  block(stepId: string, reason: string): AdvanceResult {
    const step = this.findStep(stepId);
    if (!step) return { ok: false, error: `No step with id "${stepId}"` };
    return this.mutateStep(step, { status: "blocked", lastError: reason });
  }

  /** Mark a step failed (any status) with a reason. */
  fail(stepId: string, reason: string): AdvanceResult {
    const step = this.findStep(stepId);
    if (!step) return { ok: false, error: `No step with id "${stepId}"` };
    return this.mutateStep(step, { status: "failed", lastError: reason });
  }

  /**
   * Rewrite the plan with a new goal and step list. The old plan is kept in
   * history with `supersededBy` pointing at the new plan; it is never mutated
   * in place. Verified steps of the superseded plan whose description matches
   * (trimmed, case-insensitive) a new step are carried forward by reference —
   * their status, attempts, lastError, and snapshotId are preserved.
   */
  rewrite(newGoal: string, steps: PlanStep[]): Plan {
    const newId = `plan-${this.nextPlanId}`;
    this.nextPlanId += 1;
    if (this.current) {
      this.history.push({ ...this.current, supersededBy: newId });
    }
    const plan: Plan = {
      id: newId,
      goal: newGoal,
      steps: this.carryForwardVerified(steps),
      revision: this.current ? this.current.revision + 1 : 1,
    };
    this.current = plan;
    return plan;
  }

  private carryForwardVerified(steps: PlanStep[]): PlanStep[] {
    const old = this.current;
    if (!old) return steps;
    const verified = old.steps.filter((s) => s.status === "verified");
    if (verified.length === 0) return steps;
    const norm = (s: string) => s.trim().toLowerCase();
    return steps.map((step) => {
      const match = verified.find((v) => norm(v.description) === norm(step.description));
      if (!match) return step;
      return {
        ...step,
        status: "verified",
        attempts: match.attempts,
        lastError: match.lastError,
        snapshotId: match.snapshotId,
      };
    });
  }

  private findStep(stepId: string): PlanStep | undefined {
    return this.current?.steps.find((s) => s.id === stepId);
  }

  private mutateStep(step: PlanStep, patch: Partial<PlanStep>): AdvanceResult {
    const updated: PlanStep = { ...step, ...patch };
    this.current = {
      ...this.current!,
      steps: this.current!.steps.map((s) => (s.id === step.id ? updated : s)),
      revision: this.current!.revision + 1,
    };
    return { ok: true, step: updated };
  }
}

/**
 * Compact, terminal-safe render of a plan — under ~15 lines. One line per
 * step with an ASCII status glyph; the current pointer marks the first
 * in-progress step (or the first pending step when none is in-progress).
 */
export function renderPlanBlock(plan: Plan): string {
  const lines: string[] = [];
  lines.push(`Plan (rev ${plan.revision}): ${plan.goal}`);
  const pointer = plan.steps.findIndex((s) => s.status === "in-progress");
  const pointerIndex = pointer >= 0 ? pointer : plan.steps.findIndex((s) => s.status === "pending");
  plan.steps.forEach((step, i) => {
    const marker = i === pointerIndex ? "->" : "  ";
    const glyph = STATUS_GLYPH[step.status];
    lines.push(`${marker} ${glyph} ${step.id}: ${step.description}`);
  });
  return lines.join("\n");
}
