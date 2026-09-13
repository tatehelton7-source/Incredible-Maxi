/**
 * Phase 0.2 — structural approval/deny layer for tool execution.
 *
 * Every tool call (built-in registry, MCP, plugin) passes through
 * `evaluateApproval` before it runs. Deny patterns are ABSOLUTE — they block
 * in every mode and every tier. Decisions are recorded in an `ApprovalLog`
 * whose schema is designed for later observability (Phase 5 will persist it).
 */

export type ApprovalDecision = "allow" | "deny" | "ask";
export type ApprovalMode = "always-ask" | "plan-then-ask" | "auto-with-gates";

export type ToolCategory = "shell" | "file-write" | "network" | "git-push" | "read-only";

export interface ApprovalPolicy {
  mode: ApprovalMode;
  /** Merged over the built-in DANGEROUS_PATTERNS. */
  denyPatterns?: RegExp[];
  /** Command substrings that never ask (read-only: ls, cat, grep, git status, ...). */
  allowlist?: string[];
  requireApprovalFor?: Array<"shell" | "file-write" | "network" | "git-push">;
}

export interface ApprovalDecisionRecord {
  /** Epoch ms. */
  ts: number;
  toolName: string;
  decision: ApprovalDecision;
  /** Which rule fired: 'deny-pattern:<name>' | 'allowlist' | 'mode:always-ask' | ... */
  rule: string;
  /** e.g. the bash command or file path, truncated to 500 chars. */
  target?: string;
}

interface DangerousPatternDef {
  name: string;
  pattern: RegExp;
}

/**
 * The built-in dangerous command patterns. Each carries a human-readable name
 * used for rule attribution in the decision log.
 */
const DANGEROUS_PATTERN_DEFS: DangerousPatternDef[] = [
  // Recursive/force deletes (POSIX).
  { name: "rm-recursive-force", pattern: /\brm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*|-{2}recursive\b|-{2}force\b)/ },
  // rm with separate -r and -f flags.
  { name: "rm-r-f", pattern: /\brm\s+-r\b[^|;&]*\s-f\b/ },
  // Windows recursive/quiet directory removal.
  { name: "windows-rd-s-q", pattern: /\b(?:rd|rmdir)\s+\/s\b/i },
  // Windows force file deletion.
  { name: "windows-del-f", pattern: /\bdel\s+\/f\b/i },
  // Raw device writes.
  { name: "dd-of", pattern: /\bdd\b[^|;&]*\bof=/ },
  // Filesystem creation.
  { name: "mkfs", pattern: /\bmkfs(?:\.\w+)?\b/ },
  // Drive formatting.
  { name: "format-drive", pattern: /\bformat\s+[a-z]:/i },
  // POSIX fork bomb.
  { name: "fork-bomb", pattern: /:\(\)\s*\{\s*:\s*\|/ },
  // Windows fork bomb.
  { name: "windows-fork-bomb", pattern: /%0\s*\|\s*%0/ },
  // Pipe-to-shell remote code execution.
  { name: "curl-pipe-shell", pattern: /\bcurl\b[^|;&]*\|\s*(?:sh|bash|zsh)\b/ },
  { name: "wget-pipe-shell", pattern: /\bwget\b[^|;&]*\|\s*(?:sh|bash|zsh)\b/ },
  { name: "irm-pipe-iex", pattern: /\birm\b[^|;&]*\|\s*iex\b/i },
  // Destructive SQL.
  { name: "drop-table", pattern: /\bDROP\s+TABLE\b/i },
  { name: "drop-database", pattern: /\bDROP\s+DATABASE\b/i },
  { name: "truncate-table", pattern: /\bTRUNCATE\s+TABLE\b/i },
  // Force-push to a git remote.
  { name: "git-push-force", pattern: /\bgit\s+push\b[^|;&]*\s(?:--force|-f)\b/ },
  // Destructive git history rewrites.
  { name: "git-reset-hard", pattern: /\bgit\s+reset\s+--hard\b/ },
  { name: "git-clean-fd", pattern: /\bgit\s+clean\s+-[a-z]*[fd][a-z]*[fd][a-z]*\b/ },
  // Privilege escalation.
  { name: "sudo", pattern: /\bsudo\b/ },
  { name: "chmod-777", pattern: /\bchmod\s+(?:-R\s+)?777\b/ },
  // Writes to system paths.
  { name: "etc-path", pattern: /\/etc\// },
  { name: "windows-system-path", pattern: /C:\\Windows/i },
  { name: "system-path", pattern: /\/System\b/ },
  // Machine control.
  { name: "shutdown-reboot", pattern: /\b(?:shutdown|reboot|poweroff|halt)\b/ },
];

/** The built-in dangerous patterns as a plain RegExp array. */
export const DANGEROUS_PATTERNS: RegExp[] = DANGEROUS_PATTERN_DEFS.map((d) => d.pattern);

/**
 * Phase 4.2 — anti-escalation patterns. Kept SEPARATE from DANGEROUS_PATTERNS
 * so the intent is legible: DANGEROUS_PATTERNS are "destructive", these are
 * "privilege escalation / credential exfiltration". They are evaluated
 * ABSOLUTELY (like deny patterns) in every mode and tier, so sandboxing fails
 * closed even if a deny pattern is incomplete.
 */
const ESCALATION_PATTERN_DEFS: DangerousPatternDef[] = [
  // Privilege-elevation wrappers.
  { name: "sudo", pattern: /\bsudo\b/ },
  { name: "doas", pattern: /\bdoas\b/ },
  { name: "runas", pattern: /\brunas\b/i },
  // Granting Everyone access via Windows ACL tools.
  { name: "setacl-everyone", pattern: /\bSetACL\b[^|;&]*\bEveryone\b/i },
  { name: "icacls-everyone", pattern: /\bicacls\b[^|;&]*(?:Everyone|BUILTIN\\Users)\b/i },
  // World-writable permission changes.
  { name: "chmod-777", pattern: /\bchmod\s+(?:-R\s+)?777\b/ },
  // Reading private SSH keys.
  { name: "ssh-private-key", pattern: /(?:~\/\.ssh|%USERPROFILE%\\\.ssh|\/home\/[^/]+\/\.ssh|\/root\/\.ssh)[^|;&]*\b(?:id_rsa|id_ed25519|id_dsa|id_ecdsa)\b/ },
  // Reading AWS credentials.
  { name: "aws-credentials", pattern: /~\/\.aws\/credentials/ },
  // Reading the shadow password file.
  { name: "etc-shadow", pattern: /\/etc\/shadow\b/ },
  // Absolute reads of .env files via bash cat.
  { name: "env-file-absolute", pattern: /\bcat\b[^|;&]*\/(?:[^/]+\/)*\.env\b/ },
];

/** The built-in escalation patterns as a plain RegExp array. */
export const ESCALATION_PATTERNS: RegExp[] = ESCALATION_PATTERN_DEFS.map((d) => d.pattern);

/**
 * Tool-category mapping covering every tool in src/tools/registry.ts.
 * Unknown tools default to the safest category ('shell').
 */
export const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  readFile: "read-only",
  writeFile: "file-write",
  editFile: "file-write",
  listDirectory: "read-only",
  glob: "read-only",
  grep: "read-only",
  bash: "shell",
  gitStatus: "read-only",
  gitDiff: "read-only",
  gitLog: "read-only",
  gitAdd: "git-push",
  gitCommit: "git-push",
  gitBranch: "read-only",
  gitCheckout: "git-push",
  webSearch: "read-only",
  fetchUrl: "read-only",
  detectLanguage: "read-only",
  runToolchain: "shell",
  plan_update: "read-only",
  plan_advance: "read-only",
  architecture_update: "file-write",
};

const READ_ONLY_TOOLS = new Set<string>(
  Object.entries(TOOL_CATEGORIES)
    .filter(([, c]) => c === "read-only")
    .map(([name]) => name)
);

/** Extract the "target" string a decision is made against. */
function extractTarget(call: { toolName: string; args: Record<string, unknown> }): string {
  let target: string;
  if (call.toolName === "bash" || call.toolName === "runToolchain") {
    target = typeof call.args.command === "string" ? call.args.command : call.toolName;
  } else if (call.toolName === "writeFile" || call.toolName === "editFile") {
    target = typeof call.args.path === "string" ? call.args.path : call.toolName;
  } else {
    target = call.toolName;
  }
  return target.length > 500 ? target.slice(0, 500) : target;
}

/**
 * Pure approval evaluator. Returns the decision, the rule that fired, and the
 * target the decision was made against.
 *
 * Order of precedence:
 *   1. Deny patterns (built-in + configured) — ABSOLUTE, every mode/tier.
 *   2. Allowlist substrings.
 *   3. Read-only tools — always allow.
 *   4. Mode mapping for sensitive categories.
 */
export function evaluateApproval(
  call: { toolName: string; args: Record<string, unknown> },
  policy: ApprovalPolicy
): { decision: ApprovalDecision; rule: string; target?: string } {
  const target = extractTarget(call);
  const category = TOOL_CATEGORIES[call.toolName] ?? "shell";

  // 1. Deny — escalation patterns (anti-escalation, absolute) then built-in
  //    dangerous patterns (with names) then configured patterns.
  for (const def of ESCALATION_PATTERN_DEFS) {
    if (def.pattern.test(target)) {
      return { decision: "deny", rule: `escalation:${def.name}`, target };
    }
  }
  for (const def of DANGEROUS_PATTERN_DEFS) {
    if (def.pattern.test(target)) {
      return { decision: "deny", rule: `deny-pattern:${def.name}`, target };
    }
  }
  for (const pattern of policy.denyPatterns ?? []) {
    if (pattern.test(target)) {
      return { decision: "deny", rule: `deny-pattern:${pattern.source}`, target };
    }
  }

  // 2. Allowlist substrings.
  const allowlist = policy.allowlist ?? [];
  if (allowlist.some((s) => target.includes(s))) {
    return { decision: "allow", rule: "allowlist", target };
  }

  // 3. Read-only tools always allow.
  if (READ_ONLY_TOOLS.has(call.toolName)) {
    return { decision: "allow", rule: "read-only", target };
  }

  // 4. Mode mapping for sensitive categories.
  const requireApprovalFor = policy.requireApprovalFor ?? [];
  const sensitiveCategory = category as Exclude<ToolCategory, "read-only">;
  switch (policy.mode) {
    case "always-ask":
      return { decision: "ask", rule: "mode:always-ask", target };
    case "plan-then-ask":
      if (requireApprovalFor.includes(sensitiveCategory)) {
        return { decision: "ask", rule: "mode:plan-then-ask", target };
      }
      return { decision: "allow", rule: "mode:default-allow", target };
    case "auto-with-gates":
      if (requireApprovalFor.includes(sensitiveCategory)) {
        return { decision: "ask", rule: "mode:auto-with-gates", target };
      }
      return { decision: "allow", rule: "mode:default-allow", target };
  }
}

/**
 * Build an ApprovalPolicy from the config `approval` section. String deny
 * patterns are compiled to RegExp; an invalid regex logs a config warning and
 * is skipped rather than crashing startup.
 *
 * When `base` is provided (e.g. an autonomy-tier preset), explicit `approval`
 * fields override it: `mode` and `allowlist` win over the base, `extraDeny`
 * patterns are appended to the base's, and `requireApprovalFor` is inherited
 * from the base (there is no explicit config field for it).
 */
export function buildApprovalPolicy(
  approval?: { mode?: ApprovalMode; extraDeny?: string[]; allowlist?: string[] },
  base?: ApprovalPolicy
): ApprovalPolicy {
  const denyPatterns: RegExp[] = [...(base?.denyPatterns ?? [])];
  for (const raw of approval?.extraDeny ?? []) {
    try {
      denyPatterns.push(new RegExp(raw));
    } catch {
      console.warn(`[approval] Skipping invalid deny pattern: ${raw}`);
    }
  }
  return {
    mode: approval?.mode ?? base?.mode ?? "always-ask",
    denyPatterns,
    allowlist: approval?.allowlist ?? base?.allowlist,
    requireApprovalFor: base?.requireApprovalFor,
  };
}

/**
 * In-memory decision log with an optional injected sink. Ring buffer capped at
 * 1000 entries. Phase 5 will persist this; the schema is defined now.
 */
export class ApprovalLog {
  private buffer: ApprovalDecisionRecord[] = [];
  private readonly sink?: (entry: ApprovalDecisionRecord) => void;

  constructor(sink?: (entry: ApprovalDecisionRecord) => void) {
    this.sink = sink;
  }

  record(entry: ApprovalDecisionRecord): void {
    this.buffer.push(entry);
    if (this.buffer.length > 1000) {
      this.buffer.shift();
    }
    this.sink?.(entry);
  }

  entries(): readonly ApprovalDecisionRecord[] {
    return this.buffer;
  }
}
