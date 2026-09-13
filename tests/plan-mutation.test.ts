import { describe, it, expect, beforeEach } from "vitest";
import { PlanStore, type PlanStep } from "../src/agent/plan.js";

describe("PlanStore rewrite carry-forward (Phase 3.3)", () => {
  let store: PlanStore;

  beforeEach(() => {
    store = new PlanStore();
  });

  it("assigns stable sequential plan ids", () => {
    const first = store.create("Goal", ["A"]);
    expect(first.id).toBe("plan-1");
    const second = store.rewrite("New goal", [
      { id: "x", description: "X", status: "pending", attempts: 0 },
    ]);
    expect(second.id).toBe("plan-2");
  });

  it("carries forward a verified step by description match, preserving snapshotId", () => {
    const first = store.create("Build with React", ["Use React", "Test"]);
    // Verify both steps; "Use React" gets a snapshot, "Test" is carried forward.
    store.update(first.goal, [
      { ...first.steps[0], status: "verified", attempts: 2, lastError: "old", snapshotId: "snap-1" },
      { ...first.steps[1], status: "verified", attempts: 1, snapshotId: "snap-2" },
    ]);

    // Rewrite to a Svelte stack — the "Use React" step is replaced by "Use Svelte",
    // but "Test" is carried forward.
    const second = store.rewrite("Build with Svelte", [
      { id: "s1", description: "Use Svelte", status: "pending", attempts: 0 },
      { id: "s2", description: "Test", status: "pending", attempts: 0 },
    ]);

    const carried = second.steps.find((s) => s.description === "Test");
    expect(carried).toBeDefined();
    expect(carried!.status).toBe("verified");
    expect(carried!.attempts).toBe(1);
    expect(carried!.snapshotId).toBe("snap-2");

    const replaced = second.steps.find((s) => s.description === "Use Svelte");
    expect(replaced!.status).toBe("pending");
  });

  it("matches descriptions case-insensitively and trimmed", () => {
    const first = store.create("Goal", ["  Run Tests  "]);
    store.update(first.goal, [
      { ...first.steps[0], status: "verified", attempts: 1, snapshotId: "snap-2" },
    ]);

    const second = store.rewrite("Goal", [
      { id: "n", description: "run tests", status: "pending", attempts: 0 },
    ]);
    expect(second.steps[0].status).toBe("verified");
    expect(second.steps[0].snapshotId).toBe("snap-2");
  });

  it("marks the old plan superseded and leaves it unmodified", () => {
    const first = store.create("Old goal", ["A"]);
    const original = JSON.parse(JSON.stringify(first));

    const second = store.rewrite("New goal", [
      { id: "y", description: "Y", status: "pending", attempts: 0 },
    ]);

    expect(second.supersededBy).toBeUndefined();
    const history = store.historyPlans();
    expect(history).toHaveLength(1);
    expect(history[0].supersededBy).toBe(second.id);
    // The old plan object is unchanged after the rewrite.
    expect(JSON.parse(JSON.stringify(first))).toEqual(original);
    expect(first.supersededBy).toBeUndefined();
  });

  it("increments revision from the superseded plan", () => {
    const first = store.create("Goal", ["A"]);
    expect(first.revision).toBe(1);
    const second = store.rewrite("Goal", [
      { id: "y", description: "Y", status: "pending", attempts: 0 },
    ]);
    expect(second.revision).toBe(2);
  });

  it("does not carry forward non-verified steps", () => {
    const first = store.create("Goal", ["A", "B"]);
    store.advance(first.steps[0].id); // A -> in-progress
    const second = store.rewrite("Goal", [
      { id: "a", description: "A", status: "pending", attempts: 0 },
      { id: "b", description: "B", status: "pending", attempts: 0 },
    ]);
    expect(second.steps[0].status).toBe("pending");
    expect(second.steps[1].status).toBe("pending");
  });
});
