/**
 * Phase 3.2 — Autonomy tiers as named presets over the Phase 0.2 ApprovalPolicy.
 *
 * Tiers are NOT a separate permission system. Each tier is a named preset of
 * the existing ApprovalPolicy; explicit `config.approval` fields override the
 * preset. Tier 3 (Autonomous) is feature-flagged off until Phase 4 ships
 * gates/sandbox/governor — enforced here at session start, not in docs.
 */

import type { ApprovalPolicy } from "./approval.js";
import { buildApprovalPolicy } from "./approval.js";
import type { MaxiConfig } from "../providers/types.js";

export type AutonomyTier = 1 | 2 | 3;

/** The named policy presets behind each autonomy tier. */
const TIER_PRESETS: Record<AutonomyTier, ApprovalPolicy> = {
  1: { mode: "always-ask" },
  2: { mode: "plan-then-ask", requireApprovalFor: ["git-push", "network", "file-write"] },
  3: { mode: "auto-with-gates", requireApprovalFor: [] },
};

/**
 * Map an autonomy tier to its ApprovalPolicy preset. `base` fields override
 * the preset (used to layer explicit config overrides on top).
 */
export function tierToPolicy(tier: AutonomyTier, base?: Partial<ApprovalPolicy>): ApprovalPolicy {
  return { ...TIER_PRESETS[tier], ...base };
}

export interface ResolvedTier {
  /** The effective tier after the Phase-4 gate. */
  tier: AutonomyTier;
  /** The tier the user actually requested. */
  requested: AutonomyTier;
  /** True when Tier 3 was requested but refused (falls back to Tier 2). */
  tier3Blocked: boolean;
}

/**
 * Resolve the requested autonomy tier against the Phase-4 feature flag and
 * sandbox availability. Tier 3 is refused (falls back to Tier 2) unless
 * `features.tier3 === true` AND `sandboxAvailable === true` (an isolation
 * runner — Docker or WSL+bwrap — is active). `sandboxAvailable` is optional:
 * when omitted it does not gate, preserving the pre-sandbox semantics.
 */
export function resolveTier(config?: {
  autonomy?: { tier?: AutonomyTier };
  features?: { tier3?: boolean };
  sandboxAvailable?: boolean;
}): ResolvedTier {
  const requested = config?.autonomy?.tier ?? 1;
  const flagOk = config?.features?.tier3 === true;
  const sandboxOk = config?.sandboxAvailable !== false;
  if (requested === 3 && (!flagOk || !sandboxOk)) {
    return { tier: 2, requested, tier3Blocked: true };
  }
  return { tier: requested, requested, tier3Blocked: false };
}

/**
 * Compose the effective ApprovalPolicy from config: when `autonomy.tier` is
 * set, the tier preset supplies the base policy and explicit `approval`
 * fields override it. With no tier configured, behavior is identical to
 * today (mode from `approval.mode` or 'always-ask').
 */
export function resolveApprovalPolicy(config?: MaxiConfig): ApprovalPolicy {
  const tier = config?.autonomy?.tier;
  if (tier === undefined) {
    return buildApprovalPolicy(config?.approval);
  }
  const resolved = resolveTier(config);
  return buildApprovalPolicy(config?.approval, tierToPolicy(resolved.tier));
}
