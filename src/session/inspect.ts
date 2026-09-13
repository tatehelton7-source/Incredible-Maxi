/**
 * Phase 5 — Observability: one-screen session inspection.
 *
 * `inspectSession` is a PURE function over a session's event array. It derives
 * a compact `SessionSummary` (counters, approvals, plan lifecycle, gates,
 * governor state, and a definitive halt reason) WITHOUT reading raw JSONL or
 * touching any model/provider. `renderSummary` turns that summary into a
 * terminal-safe, ASCII-only block (≤ 25 lines) for `maxi session inspect`.
 *
 * Halt-reason precedence (first match wins):
 *   1. Governor breach  — most recent governor event is a `governor-breach`.
 *   2. Stall/escalation — last `plan-advanced` event reached `blocked`.
 *   3. Gate failure     — last `plan-advanced` event reached `failed`.
 *   4. User stop        — last event is a user `/exit`, or a trailing
 *                         assistant message with no follow-up.
 *   5. Interrupted call — `getInterruptedCall` is non-null.
 *   6. Default          — "session ended normally or is still running".
 */

import chalk from "chalk";
import { getInterruptedCall, type SessionEvent } from "./store.js";

export interface SessionSummary {
  sessionId: string;
  /** Epoch ms of the first event (the format-version header). */
  startedAt: number;
  eventCount: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: { total: number; perTool: Record<string, number> };
  approvals: {
    allowed: number;
    asked: number;
    denied: number;
    rulesFired: Record<string, number>;
  };
  planEvents: { created: number; advanced: number; rewritten: number; carriedVerified: number };
  gates: { passed: number; failed: number };
  governor: { breaches: string[]; resets: number };
  interrupted: boolean;
  haltReason: string;
}

/** The last `plan-advanced` event, or null when none exists. */
function lastPlanAdvanced(events: SessionEvent[]): SessionEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "plan-advanced") return events[i];
  }
  return null;
}

/** The most recent governor event (breach or reset), or null. */
function lastGovernorEvent(events: SessionEvent[]): SessionEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === "session-meta" && (ev.key === "governor-breach" || ev.key === "governor-reset")) {
      return ev;
    }
  }
  return null;
}

/** Derive the halt reason per the documented precedence. */
function deriveHaltReason(events: SessionEvent[]): string {
  const governor = lastGovernorEvent(events);
  if (governor && governor.type === "session-meta" && governor.key === "governor-breach") {
    return `Governor breach: ${governor.value}`;
  }

  const advanced = lastPlanAdvanced(events);
  if (advanced && advanced.type === "plan-advanced") {
    if (advanced.to === "blocked") {
      return "Plan step blocked after stall (escalation)";
    }
    if (advanced.to === "failed") {
      return "Gate failure loop: step failed verification";
    }
  }

  const last = events[events.length - 1];
  if (last) {
    if (last.type === "user-message" && last.text.includes("/exit")) {
      return "User stopped the session";
    }
    if (last.type === "assistant-message") {
      return "User stopped the session";
    }
  }

  if (getInterruptedCall(events)) {
    return "Interrupted tool call";
  }

  return "Session ended normally or is still running";
}

/**
 * Build a compact summary from a session's event array. Pure — no I/O, no
 * model/provider access. Absent signals yield 0 / empty collections.
 */
export function inspectSession(events: SessionEvent[]): SessionSummary {
  const summary: SessionSummary = {
    sessionId: events[0]?.sessionId ?? "",
    startedAt: events[0]?.ts ?? 0,
    eventCount: events.length,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: { total: 0, perTool: {} },
    approvals: { allowed: 0, asked: 0, denied: 0, rulesFired: {} },
    planEvents: { created: 0, advanced: 0, rewritten: 0, carriedVerified: 0 },
    gates: { passed: 0, failed: 0 },
    governor: { breaches: [], resets: 0 },
    interrupted: false,
    haltReason: "",
  };

  for (const ev of events) {
    switch (ev.type) {
      case "user-message":
        summary.userMessages += 1;
        break;
      case "assistant-message":
        summary.assistantMessages += 1;
        break;
      case "tool-call":
        summary.toolCalls.total += 1;
        summary.toolCalls.perTool[ev.toolName] = (summary.toolCalls.perTool[ev.toolName] ?? 0) + 1;
        break;
      case "approval-decision":
        if (ev.decision === "allow") summary.approvals.allowed += 1;
        else if (ev.decision === "ask") summary.approvals.asked += 1;
        else if (ev.decision === "deny") summary.approvals.denied += 1;
        summary.approvals.rulesFired[ev.rule] = (summary.approvals.rulesFired[ev.rule] ?? 0) + 1;
        break;
      case "plan-created":
        summary.planEvents.created += 1;
        break;
      case "plan-advanced":
        summary.planEvents.advanced += 1;
        if (ev.to === "verified") summary.gates.passed += 1;
        else if (ev.to === "failed") summary.gates.failed += 1;
        break;
      case "plan-rewritten":
        summary.planEvents.rewritten += 1;
        summary.planEvents.carriedVerified += ev.carriedVerified;
        break;
      case "session-meta":
        if (ev.key === "governor-breach") summary.governor.breaches.push(ev.value);
        else if (ev.key === "governor-reset") summary.governor.resets += 1;
        break;
      default:
        break;
    }
  }

  summary.interrupted = getInterruptedCall(events) !== null;
  summary.haltReason = deriveHaltReason(events);
  return summary;
}

/**
 * Render a summary as a compact, ASCII-only block (≤ 25 lines). Pure — returns
 * a string so tests never touch stdout. Uses chalk for terminal coloring.
 */
export function renderSummary(s: SessionSummary): string {
  const lines: string[] = [];
  lines.push(chalk.bold(`Session ${s.sessionId}`));
  lines.push(`  Started:    ${new Date(s.startedAt).toISOString()}`);
  lines.push(`  Events:     ${s.eventCount}`);
  lines.push(`  Messages:   ${s.userMessages} user / ${s.assistantMessages} assistant`);
  lines.push(`  Tool calls: ${s.toolCalls.total}`);

  const toolNames = Object.keys(s.toolCalls.perTool);
  if (toolNames.length > 0) {
    const perTool = toolNames
      .map((name) => `${name}=${s.toolCalls.perTool[name]}`)
      .join(", ");
    lines.push(`    ${perTool}`);
  }

  lines.push(
    `  Approvals:  ${s.approvals.allowed} allowed / ${s.approvals.asked} asked / ${s.approvals.denied} denied`
  );
  const rules = Object.keys(s.approvals.rulesFired);
  if (rules.length > 0) {
    const fired = rules.map((r) => `${r}=${s.approvals.rulesFired[r]}`).join(", ");
    lines.push(`    rules: ${fired}`);
  }

  lines.push(
    `  Plan:       ${s.planEvents.created} created / ${s.planEvents.advanced} advanced / ${s.planEvents.rewritten} rewritten / ${s.planEvents.carriedVerified} carried-verified`
  );
  lines.push(`  Gates:      ${s.gates.passed} passed / ${s.gates.failed} failed`);

  const breaches = s.governor.breaches;
  lines.push(
    `  Governor:   ${breaches.length} breach(es) / ${s.governor.resets} reset(s)` +
      (breaches.length > 0 ? ` - ${breaches[breaches.length - 1]}` : "")
  );
  lines.push(`  Interrupted: ${s.interrupted ? "yes" : "no"}`);
  lines.push(`  Halt reason: ${s.haltReason}`);

  return lines.join("\n");
}
