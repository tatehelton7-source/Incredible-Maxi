import * as readline from "node:readline";
import { stdin, stdout } from "node:process";
import chalk from "chalk";
import { z } from "zod";
import { streamText, isStepCount } from "ai";
import type { LanguageModel } from "ai";
import type { MaxiConfig, PlanModeConfig } from "./providers/types.js";
import { WorkflowPhase } from "./providers/types.js";
import { ContextEngine } from "./context/engine.js";
import type { AgentOrchestrator } from "./agents/orchestrator.js";
import type { AutomationEngine } from "./automation/engine.js";
import type { AcpClient, AcpServer } from "./acp/adapter.js";
import { discoverAll } from "./models/registry.js";
import { runSelectorUI } from "./ui/selector.js";
import { runConfigureUI } from "./ui/configure.js";
import fetch from "node-fetch";
import { Spinner } from "./ui/spinner.js";
import {
  readFileSchema,
  writeFileSchema,
  editFileSchema,
  bashSchema,
  listDirectorySchema,
  globSchema,
  grepSchema,
} from "./tools/schemas/index.js";
import { buildToolRegistry } from "./tools/registry.js";
import {
  evaluateApproval,
  ApprovalLog,
  buildApprovalPolicy,
  type ApprovalPolicy,
} from "./tools/approval.js";
import {
  resolveApprovalPolicy,
  resolveTier,
  tierToPolicy,
  type AutonomyTier,
} from "./tools/tiers.js";
import type { McpClient } from "./mcp/client.js";
import type { Tool } from "./tools/types.js";
import type { SnapshotManager } from "./snapshots.js";
import { getTheme, listThemes, isValidTheme, type Theme } from "./ui/themes.js";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SessionStore,
  getInterruptedCall,
  resolveInterruptedCall,
  reconstructHistory,
  type SessionEventInput,
} from "./session/store.js";
import { PlanStore, renderPlanBlock, type Plan, type PlanStep, type GateRunResult } from "./agent/plan.js";
import { ToolFailureTracker, normalizeSignature } from "./agent/loop-guards.js";
import { runGateCommand, detectToolchainGates } from "./agent/gates.js";
import { SessionGovernor } from "./agent/governor.js";
import { sandboxCapability, type StepIntent } from "./tools/sandbox.js";
import { selectRunner, setSandboxRunner } from "./tools/sandbox-runners.js";
import { detectLanguage } from "./tools/language.js";
import { FactStore } from "./agent/facts.js";
import { readArchMap, updateArchMap, renderArchMapSection } from "./agent/archmap.js";
import { compactHistory, type CompactResult } from "./context/compactor.js";

export interface ReplOptions {
  model: LanguageModel;
  contextEngine: ContextEngine;
  orchestrator?: AgentOrchestrator;
  systemPrompt?: string;
  provider?: string;
  modelName?: string;
  registry?: ReturnType<typeof import("./providers/registry.js").buildRegistry>;
  config?: MaxiConfig;
  mcpClient?: McpClient;
  pluginTools?: Tool[];
  loadedPlugins?: Array<{ name: string; description: string; tools: string[] }>;
  destroyPlugins?: () => Promise<void>;
  snapshotManager?: SnapshotManager;
  automationEngine?: AutomationEngine;
  acpClient?: AcpClient;
  acpServer?: AcpServer;
  /** Durable-session store (Phase 2). When present, events are recorded. */
  sessionStore?: SessionStore;
  /** The active session id to append events to. */
  sessionId?: string;
  /** When true, replay history and handle any interrupted tool call on start. */
  resume?: boolean;
  /** Override for toolchain detection (Phase 4.1). When omitted, detected from cwd. */
  toolchainDetected?: boolean;
  /** Project working directory for facts/archmap storage (Phase 6). Defaults to process.cwd(). */
  cwd?: string;
}

export class Repl {
  private rl: readline.Interface;
  private model: LanguageModel;
  private contextEngine: ContextEngine;
  private orchestrator: AgentOrchestrator | undefined;
  private systemPrompt: string;
  private history: Array<{ role: "user" | "assistant"; content: string }> = [];
  private running = false;
  private provider: string;
  private modelName: string;
  private registry: ReturnType<typeof import("./providers/registry.js").buildRegistry> | undefined;
  private config: MaxiConfig | undefined;
  private mcpClient: McpClient | undefined;
  private pluginTools: Tool[];
  private loadedPlugins: Array<{ name: string; description: string; tools: string[] }>;
  private destroyPlugins?: () => Promise<void>;
  /** Active plan-mode state; toggled via /plan. */
  private planMode: PlanModeConfig;
  /** Spinner for visual feedback during LLM/tool operations. */
  private spinner: Spinner;
  private snapshotManager: SnapshotManager | undefined;
  private automationEngine: AutomationEngine | undefined;
  private acpClient: AcpClient | undefined;
  private acpServer: AcpServer | undefined;
  private agents: string[];
  private theme: Theme;
  /** Index into agents[] for the currently selected agent. */
  private currentAgentIndex = 0;
  /** Approval policy built from config (Phase 0.2). */
  private approvalPolicy: ApprovalPolicy;
  /** Effective autonomy tier (Phase 3.2). */
  private currentTier: AutonomyTier;
  /** True once the Tier-3 fallback warning has been printed this session. */
  private tier3WarningShown = false;
  /** True once an isolation sandbox runner (docker/wsl-bwrap) is active. */
  private sandboxAvailable = true;
  /** Per-session set of targets the user chose "always allow". */
  private sessionAllowlist = new Set<string>();
  /** Decision log for the approval layer. */
  private approvalLog: ApprovalLog;
  private sessionStore: SessionStore | undefined;
  private sessionId: string | undefined;
  private resume: boolean;
  /** Frozen system prompt — built once at REPL start, never mutated mid-session. */
  private frozenSystemPrompt = "";
  /** In-memory plan artifact store (Phase 3.1). */
  private planStore: PlanStore;
  /** Tool-failure tracker for stall detection + retry budget (Phase 3.4). */
  private failureTracker: ToolFailureTracker;
  /** True when test/lint tooling was detected in cwd (Phase 4.1). */
  private toolchainDetected: boolean;
  /** True once the no-toolchain warning has been printed this session. */
  private toolchainWarningShown = false;
  /** Session governor (Phase 4.3) — halts on wall-clock/tool-call/token ceilings. */
  private governor: SessionGovernor;
  /** Sandbox capability report (Phase 4.2), computed once at REPL start. */
  private readonly sandboxCap: ReturnType<typeof sandboxCapability>;
  /** Provenance-tagged facts memory (Phase 6). */
  private factStore: FactStore;
  /** Architecture map content loaded at session start (Phase 6). */
  private archMap: string | null = null;
  /** Facts added mid-session that must NOT mutate the frozen prompt (Phase 6). */
  private midSessionFacts: string[] = [];
  /** Project working directory for facts/archmap storage (Phase 6). */
  private readonly cwd: string;
  private readonly compactionConfig: import("./providers/types.js").ContextCompactionConfig | undefined;

  constructor(opts: ReplOptions) {
    this.model = opts.model;
    this.contextEngine = opts.contextEngine;
    this.orchestrator = opts.orchestrator;
    this.systemPrompt = opts.systemPrompt || "You are Maxi, a helpful AI coding assistant.";
    this.provider = opts.provider || "nvidia";
    this.modelName = opts.modelName || "meta/llama-3.1-8b-instruct";
    this.registry = opts.registry;
    this.config = opts.config;
    this.mcpClient = opts.mcpClient;
    this.pluginTools = opts.pluginTools ?? [];
    this.loadedPlugins = opts.loadedPlugins ?? [];
    this.destroyPlugins = opts.destroyPlugins;
    this.snapshotManager = opts.snapshotManager;
    this.automationEngine = opts.automationEngine;
    this.acpClient = opts.acpClient;
    this.acpServer = opts.acpServer;
    // Plan-mode toggle from config at REPL startup. Defaults to off.
    this.planMode = {
      ...opts.config?.planMode,
      enabled: opts.config?.planMode?.enabled ?? false,
      enforced: opts.config?.planMode?.enforced ?? false,
      phase: opts.config?.planMode?.phase ?? WorkflowPhase.IDLE,
      requireApproval: opts.config?.planMode?.requireApproval ?? true,
    };
    // Initialize spinner with config
    this.spinner = new Spinner({
      enabled: opts.config?.spinner?.enabled ?? true,
      theme: opts.config?.spinner?.theme ?? "dots",
    });
    this.agents = opts.config?.agents ?? ["builder", "researcher", "reviewer"];
    this.theme = getTheme(opts.config?.theme ?? "default");
    const resolvedTier = resolveTier(opts.config);
    this.currentTier = resolvedTier.tier;
    if (resolvedTier.tier3Blocked) {
      console.log(chalk.yellow("  Tier 3 requires Phase 4 (gates/sandbox/governor) — falling back to Tier 2"));
      this.tier3WarningShown = true;
    }
    this.approvalPolicy = resolveApprovalPolicy(opts.config);
    this.sessionStore = opts.sessionStore;
    this.sessionId = opts.sessionId;
    this.resume = opts.resume ?? false;
    this.planStore = new PlanStore();
    this.failureTracker = new ToolFailureTracker();
    this.toolchainDetected =
      opts.toolchainDetected ?? detectToolchainGates(process.cwd()).length > 0;
    this.approvalLog = new ApprovalLog((entry) => {
      if (!this.sessionStore || !this.sessionId) return;
      this.sessionStore.appendSync(this.sessionId, {
        type: "approval-decision",
        toolName: entry.toolName,
        decision: entry.decision,
        rule: entry.rule,
        target: entry.target,
      });
    });
    this.sandboxCap = sandboxCapability();
    this.cwd = opts.cwd ?? process.cwd();
    this.compactionConfig = opts.config?.context;
    this.factStore = new FactStore(this.cwd);
    this.governor = new SessionGovernor({
      maxWallClockMs: (opts.config?.governor?.maxMinutes ?? 30) * 60 * 1000,
      maxToolCalls: opts.config?.governor?.maxToolCalls ?? 100,
      maxTokens: opts.config?.governor?.maxTokens ?? 500_000,
      onBreach: (info) => {
        void this.recordEvent({
          type: "session-meta",
          key: "governor-breach",
          value: info.reason,
        });
      },
    });
    this.rl = readline.createInterface({
      input: stdin,
      output: stdout,
      prompt: this.getPrompt(),
    });
    this.setupTabCycling();
  }

  private getPrompt(): string {
    if (this.agents.length === 0) return chalk.cyan("maxi> ");
    return chalk.cyan(`[${this.agents[this.currentAgentIndex]}]> `);
  }

  private setupTabCycling(): void {
    if (this.agents.length === 0) return;

    process.stdin.on("keypress", (_str: string, key: readline.Key) => {
      if (!key || key.name !== "tab") return;

      this.currentAgentIndex = (this.currentAgentIndex + 1) % this.agents.length;
      const agent = this.agents[this.currentAgentIndex];

      this.rl.setPrompt(this.getPrompt());
      process.stdout.write("\r\x1B[K");
      console.log(chalk.dim(`  Agent: ${agent}`));
      this.rl.prompt();
    });
  }

  private static readonly WRITE_TOOLS = new Set([
    "writeFile",
    "editFile",
    "bash",
    "gitAdd",
    "gitCommit",
    "gitCheckout",
  ]);

  /** Append a session event, awaiting the write so the log stays consistent on exit. */
  private async recordEvent(event: SessionEventInput): Promise<void> {
    if (!this.sessionStore || !this.sessionId) return;
    await this.sessionStore.append(this.sessionId, event);
  }

  /**
   * True when the current plan has at least one step without a gate. Used by
   * the no-toolchain fallback: with no toolchain, ungated steps cannot be
   * verified by a gate, so writes must fall back to approval.
   */
  private hasUngatedPlan(): boolean {
    const plan = this.planStore.get();
    if (!plan) return false;
    return plan.steps.some((s) => !s.gate);
  }

  /**
   * Effective approval policy for a single tool call. When no toolchain is
   * detected and an active plan has ungated steps, `file-write` is merged into
   * `requireApprovalFor` so writes require approval. This is a computed overlay
   * — `this.approvalPolicy` is never mutated.
   */
  private computeEffectivePolicy(): ApprovalPolicy {
    if (!this.toolchainDetected && this.hasUngatedPlan()) {
      const requireApprovalFor = this.approvalPolicy.requireApprovalFor ?? [];
      if (!requireApprovalFor.includes("file-write")) {
        return { ...this.approvalPolicy, requireApprovalFor: [...requireApprovalFor, "file-write"] };
      }
    }
    return this.approvalPolicy;
  }

  /** Print the one-time no-toolchain warning when a plan has ungated steps. */
  private maybeWarnNoToolchain(): void {
    if (this.toolchainDetected || this.toolchainWarningShown) return;
    if (!this.hasUngatedPlan()) return;
    this.toolchainWarningShown = true;
    console.log(
      chalk.yellow("  no test suite detected — verification is limited to approval-gated writes")
    );
  }

  /**
   * Run a step's gate command. On exit 0 with a snapshot manager available,
   * save a snapshot and emit the `snapshot` event; the returned snapshotId is
   * written onto the step by the plan store.
   */
  private async runGate(command: string): Promise<GateRunResult> {
    const result = await runGateCommand(command, { cwd: process.cwd() });
    let snapshotId: string | undefined;
    if (result.exitCode === 0 && this.snapshotManager) {
      const snap = await this.snapshotManager.saveSnapshot();
      if (snap.success && snap.hash) {
        snapshotId = snap.hash;
        await this.recordEvent({ type: "snapshot", snapshotId });
      }
    }
    return { exitCode: result.exitCode, output: result.output, snapshotId };
  }

  /**
   * The current plan step's sandbox intent (declared writes + network), or
   * null when no plan step is active. Callers fall back to the adhoc intent
   * (whole project root writable) when this returns null.
   */
  private currentStepIntent(): StepIntent | null {
    const plan = this.planStore.get();
    if (!plan) return null;
    const step =
      plan.steps.find((s) => s.status === "in-progress") ??
      plan.steps.find((s) => s.status === "pending");
    if (!step) return null;
    return {
      stepId: step.id,
      declaredWrites: (step.declaredWrites ?? []).map((p) => ({ path: p })),
      ...(step.network ? { network: step.network } : {}),
    };
  }

  /**
   * Replay a session's events to rebuild conversation history, then handle any
   * interrupted tool call: read-only tools are re-run, side-effecting tools are
   * skipped with a notice (never double-executed, never silently completed).
   */
  private async resumeSession(): Promise<void> {
    if (!this.sessionStore || !this.sessionId) return;
    const events = await this.sessionStore.readAll(this.sessionId);
    this.history = reconstructHistory(events);

    const interrupted = getInterruptedCall(events);
    if (!interrupted || interrupted.type !== "tool-call") {
      console.log(chalk.dim(`  Resumed session ${this.sessionId} (${events.length} events).\n`));
      return;
    }

    if (resolveInterruptedCall(interrupted) === "rerun") {
      console.log(
        chalk.dim(
          `  Resumed session ${this.sessionId}: re-running interrupted read-only tool ${interrupted.toolName}.\n`
        )
      );
      const tools = this.getTools();
      const tool = tools[interrupted.toolName];
      if (tool && typeof tool.execute === "function") {
        await tool.execute(interrupted.args);
      }
      return;
    }

    console.log(
      chalk.yellow(
        `  Resumed session ${this.sessionId}: step ${interrupted.toolName} was interrupted mid-call; not re-run — verify state manually.\n`
      )
    );
    await this.recordEvent({
      type: "session-meta",
      key: "resumed-with-interrupt",
      value: interrupted.callId,
    });
  }

  /** Get tool definitions for function calling. */
  private getTools() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: Record<string, any> = {};

    const schemaOverrides: Record<string, unknown> = {
      readFile: readFileSchema,
      writeFile: writeFileSchema,
      editFile: editFileSchema,
      bash: bashSchema,
      listDirectory: listDirectorySchema,
      glob: globSchema,
      grep: grepSchema,
    };

    const destructiveWarnings: Record<string, string> = {
      writeFile: " — WARNING: ask before destructive writes",
      bash: " (WARNING: ask before destructive commands)",
    };

    const isWriteBlocked = (toolName: string): boolean =>
      this.planMode.enabled === true &&
      this.planMode.enforced === true &&
      Repl.WRITE_TOOLS.has(toolName);

    const wrapExecute = (
      toolName: string,
      executeFn: (args: Record<string, unknown>) => Promise<string>,
    ) => {
      return async (args: Record<string, unknown>): Promise<string> => {
        const callId = randomUUID();
        await this.recordEvent({ type: "tool-call", callId, toolName, args });

        const approval = evaluateApproval({ toolName, args }, this.computeEffectivePolicy());
        let decision = approval.decision;
        let rule = approval.rule;
        const target = approval.target ?? toolName;

        // Session allowlist: previously "always allow" targets auto-allow.
        if (decision === "ask" && this.sessionAllowlist.has(target)) {
          decision = "allow";
          rule = "session-allow";
        }

        this.approvalLog.record({
          ts: Date.now(),
          toolName,
          decision,
          rule,
          target,
        });

        if (decision === "deny") {
          const output = `Blocked by policy: ${rule}`;
          await this.recordEvent({ type: "tool-result", callId, ok: false, output });
          return output;
        }

        if (decision === "ask") {
          const answer = await this.promptForApproval(toolName, target);
          if (answer === "deny") {
            this.approvalLog.record({
              ts: Date.now(),
              toolName,
              decision: "deny",
              rule: "user-denied",
              target,
            });
            const output = `Blocked by policy: user-denied`;
            await this.recordEvent({ type: "tool-result", callId, ok: false, output });
            return output;
          }
          if (answer === "session-allow") {
            this.sessionAllowlist.add(target);
          }
        }

        // Phase 4.3 — governor check AFTER approval, BEFORE execution. A breach
        // halts the session; it does NOT auto-resume (requires /continue).
        const governorCheck = this.governor.checkToolCall();
        if (!governorCheck.ok) {
          const output = `Session governor halted: ${governorCheck.reason}. Approval required to continue.`;
          await this.recordEvent({ type: "tool-result", callId, ok: false, output });
          return output;
        }

        if (isWriteBlocked(toolName)) {
          const output = "Plan mode is active. File modifications are blocked. Use /plan off to disable.";
          await this.recordEvent({ type: "tool-result", callId, ok: false, output });
          return output;
        }
        if (this.snapshotManager && Repl.WRITE_TOOLS.has(toolName)) {
          await this.snapshotManager.saveSnapshot();
        }
        try {
          const output = await executeFn(args);
          const ok = !output.startsWith("Error: ");
          await this.recordEvent({ type: "tool-result", callId, ok, output });
          if (!ok) {
            await this.handleToolFailure(toolName, target, output);
          }
          return output;
        } catch (err) {
          const output = `Error: ${err instanceof Error ? err.message : String(err)}`;
          await this.recordEvent({ type: "tool-result", callId, ok: false, output });
          await this.handleToolFailure(toolName, target, output);
          return output;
        }
      };
    };

    if (this.config) {
      const registryTools = buildToolRegistry(this.config);
      for (const tool of registryTools) {
        tools[tool.name] = {
          description: tool.description + (destructiveWarnings[tool.name] ?? ""),
          inputSchema: schemaOverrides[tool.name],
          execute: wrapExecute(tool.name, async (args: Record<string, unknown>) => {
            const result = await tool.execute(args);
            return result.success ? result.output : `Error: ${result.error}`;
          }),
        };
      }
    }

    if (this.mcpClient) {
      for (const mcpTool of this.mcpClient.getAllTools()) {
        tools[mcpTool.name] = {
          description: mcpTool.description,
          inputSchema: undefined,
          execute: wrapExecute(mcpTool.name, async (args: Record<string, unknown>) => {
            const result = await mcpTool.execute(args);
            return result.success ? result.output : `Error: ${result.error}`;
          }),
        };
      }
    }

    for (const tool of this.pluginTools) {
      tools[tool.name] = {
        description: tool.description,
        inputSchema: undefined,
        execute: wrapExecute(tool.name, async (args: Record<string, unknown>) => {
          const result = await tool.execute(args);
          return result.success ? result.output : `Error: ${result.error}`;
        }),
      };
    }

    // Plan tools are added LAST so registry/MCP/plugin names win on collision.
    const planTools: Array<{ name: string; description: string; inputSchema: unknown; execute: (args: Record<string, unknown>) => Promise<string> }> = [
      {
        name: "plan_update",
        description:
          "Create or replace the working plan. Provide a goal and the full ordered list of step descriptions. Creates the plan if none exists; otherwise rewrites it as a new immutable version, carrying forward verified steps.",
        inputSchema: z.object({
          goal: z.string().describe("The overall goal of the plan"),
          steps: z
            .array(
              z.union([
                z.string().describe("A step description"),
                z
                  .object({
                    description: z.string().describe("The step description"),
                    gate: z
                      .string()
                      .optional()
                      .describe("Shell command whose exit 0 verifies this step"),
                    declaredWrites: z
                      .array(z.string())
                      .optional()
                      .describe("Paths (relative to project root) this step will write"),
                    network: z
                      .object({ domains: z.array(z.string()) })
                      .optional()
                      .describe("Network domains this step needs to reach"),
                  })
                  .describe("A step with an optional verification gate"),
              ])
            )
            .describe("Ordered step descriptions, optionally with a gate command"),
        }),
        execute: async (args: Record<string, unknown>) => {
          const goal = String(args.goal ?? "");
          const rawSteps = Array.isArray(args.steps) ? args.steps : [];
          const steps = rawSteps.map((s) => {
            if (typeof s === "string") return { description: s, gate: undefined };
            const obj = s as {
              description?: unknown;
              gate?: unknown;
              declaredWrites?: unknown;
              network?: unknown;
            };
            const gate = typeof obj.gate === "string" && obj.gate.trim() ? obj.gate : undefined;
            const declaredWrites = Array.isArray(obj.declaredWrites)
              ? obj.declaredWrites.filter((p): p is string => typeof p === "string")
              : undefined;
            const network =
              obj.network && typeof obj.network === "object"
                ? {
                    domains: Array.isArray((obj.network as { domains?: unknown }).domains)
                      ? (obj.network as { domains: unknown[] }).domains.filter(
                          (d): d is string => typeof d === "string"
                        )
                      : [],
                  }
                : undefined;
            return { description: String(obj.description ?? ""), gate, declaredWrites, network };
          });
          if (!goal || steps.length === 0) {
            return "Error: plan_update requires a non-empty goal and at least one step";
          }
          if (!this.planStore.get()) {
            const plan = this.planStore.create(goal, steps);
            await this.recordEvent({
              type: "plan-created",
              goal,
              stepCount: steps.length,
              planId: plan.id,
            });
            this.maybeWarnNoToolchain();
            return `Plan created (${steps.length} steps).`;
          }
          const freshSteps: PlanStep[] = steps.map(({ description, gate, declaredWrites, network }) => ({
            id: `step-${Math.random().toString(36).slice(2, 8)}`,
            description,
            status: "pending",
            attempts: 0,
            ...(gate ? { gate } : {}),
            ...(declaredWrites && declaredWrites.length > 0 ? { declaredWrites } : {}),
            ...(network ? { network } : {}),
          }));
          const oldPlan = this.planStore.get()!;
          const newPlan = this.planStore.rewrite(goal, freshSteps);
          const carriedVerified = newPlan.steps.filter((s) => s.status === "verified").length;
          await this.recordEvent({
            type: "plan-rewritten",
            oldPlanId: oldPlan.id,
            newPlanId: newPlan.id,
            carriedVerified,
          });
          this.maybeWarnNoToolchain();
          return `Plan rewritten (${steps.length} steps).`;
        },
      },
      {
        name: "plan_advance",
        description:
          "Advance a plan step to its next status: pending → in-progress, or in-progress → verified. A step with a gate is verified only by running its gate command and getting exit 0; a passing gate auto-snapshots.",
        inputSchema: z.object({
          stepId: z.string().describe("The id of the step to advance"),
        }),
        execute: async (args: Record<string, unknown>) => {
          const stepId = String(args.stepId ?? "");
          const plan = this.planStore.get();
          const step = plan?.steps.find((s) => s.id === stepId);
          const result = step?.gate
            ? await this.planStore.advanceWithGate(stepId, (command) => this.runGate(command))
            : this.planStore.advance(stepId);
          if (result.ok) {
            const current = this.planStore.get();
            if (current) {
              await this.recordEvent({
                type: "plan-advanced",
                planId: current.id,
                stepId,
                to: result.step.status,
              });
            }
            return `Step "${stepId}" is now ${result.step.status}.`;
          }
          return `Error: ${result.error}`;
        },
      },
    ];

    for (const planTool of planTools) {
      if (tools[planTool.name]) {
        console.warn(`[repl] Skipping plan tool "${planTool.name}": name already in use`);
        continue;
      }
      tools[planTool.name] = {
        description: planTool.description,
        inputSchema: planTool.inputSchema,
        execute: wrapExecute(planTool.name, async (args: Record<string, unknown>) => planTool.execute(args)),
      };
    }

    // Phase 6 — architecture_update tool. Its ONLY input is the full desired
    // content; it validates (≤200 lines, starts with '# ') then writes
    // .maxi/architecture.md. Category 'file-write' so approval policy applies.
    const architectureUpdateTool = {
      name: "architecture_update",
      description:
        "Write the project architecture map to .maxi/architecture.md. Provide the FULL desired content. " +
        "Must be valid Markdown, start with a '# ' heading, and be ≤ 200 lines. " +
        "If it exceeds 200 lines, prune it and retry.",
      inputSchema: z.object({
        content: z.string().describe("The full desired architecture.md content"),
      }),
      execute: async (args: Record<string, unknown>) => {
        const content = String(args.content ?? "");
        const result = await updateArchMap(process.cwd(), content);
        if (!result.ok) return result.error;
        this.archMap = content;
        return `Architecture map updated (${content.split("\n").length} lines).`;
      },
    };
    if (tools[architectureUpdateTool.name]) {
      console.warn(`[repl] Skipping tool "${architectureUpdateTool.name}": name already in use`);
    } else {
      tools[architectureUpdateTool.name] = {
        description: architectureUpdateTool.description,
        inputSchema: architectureUpdateTool.inputSchema,
        execute: wrapExecute(
          architectureUpdateTool.name,
          async (args: Record<string, unknown>) => architectureUpdateTool.execute(args)
        ),
      };
    }

    return tools;
  }

  /**
   * Classify a tool-execution failure against the current in-progress plan step:
   * stall detection (same command + same error twice) blocks the step and
   * escalates per tier; otherwise the per-step retry budget marks it failed.
   */
  private async handleToolFailure(toolName: string, target: string, output: string): Promise<void> {
    const plan = this.planStore.get();
    if (!plan) return;
    const step = plan.steps.find((s) => s.status === "in-progress");
    if (!step) return;

    this.failureTracker.setCurrentStep(step.id);
    const signature = normalizeSignature(output);
    this.failureTracker.recordFailure(toolName, target, signature);

    if (this.failureTracker.isStalled(toolName, target, signature)) {
      this.planStore.block(step.id, `Stalled: repeated identical failure (${toolName})`);
      console.log(chalk.yellow(`[stall detection] step ${step.id} blocked: repeated identical failure`));
      await this.escalateStall(step.id);
      return;
    }

    const retryBudget = this.config?.autonomy?.retryBudget ?? 3;
    if (this.failureTracker.attemptsFor(step.id) >= retryBudget) {
      this.planStore.fail(step.id, `Exceeded retry budget (${retryBudget}): ${output}`);
      console.log(chalk.yellow(`[retry budget] step ${step.id} failed after ${retryBudget} attempts`));
    }
  }

  /** Tier escalation on stall: Tier 3 skips to the next pending step; Tiers 1/2 instruct the user. */
  private async escalateStall(stepId: string): Promise<void> {
    if (this.currentTier === 3) {
      const plan = this.planStore.get();
      if (!plan) return;
      const next = plan.steps.find((s) => s.status === "pending");
      if (next) {
        this.planStore.advance(next.id);
        console.log(chalk.dim(`[stall detection] skipping to next pending step ${next.id}`));
      }
      return;
    }
    console.log(
      chalk.dim("  [stall detection] Review the blocked step and adjust the plan (plan_update) or retry manually.")
    );
  }

  async start(): Promise<void> {
    this.running = true;
    console.log(chalk.cyan.bold("\n  Maxi — Interactive Mode\n"));
    console.log(chalk.dim("  Type your message and press Enter. Type /help for commands, /exit to quit.\n"));

    await this.contextEngine.indexCodebase();
    console.log(chalk.dim(`  Indexed ${this.contextEngine.getFileCount()} files in the codebase.\n`));
    console.log(chalk.dim(`  Model: ${this.provider}/${this.modelName}\n`));
    await this.ensureFrozenPrompt();

    // Phase 4.2 — sandbox runner selection + capability report. Runs after
    // session store init so denials can be recorded into the session JSONL.
    try {
      const selected = await selectRunner({
        config: this.config?.sandbox,
        sessionId: this.sessionId ?? "",
        maxiStore: this.sessionStore,
        detectRuntime: async (root) => {
          const lang = (await detectLanguage(root)).language;
          if (lang === "TypeScript" || lang === "JavaScript") return "node-20";
          if (lang === "Python") return "python-3.12";
          return "generic";
        },
      });
      setSandboxRunner(selected.runner, () => this.currentStepIntent());
      this.sandboxAvailable = selected.supportsUnattendedAutonomy;
      console.log(chalk.dim(`  ${selected.statusLine}`));
      if (!selected.supportsUnattendedAutonomy && this.currentTier === 3) {
        const resolved = resolveTier({
          autonomy: { tier: 3 },
          features: this.config?.features,
          sandboxAvailable: false,
        });
        this.currentTier = resolved.tier;
        this.approvalPolicy = buildApprovalPolicy(this.config?.approval, tierToPolicy(resolved.tier));
        console.log(
          chalk.yellow("  Tier 3 requires an isolation sandbox (Docker or WSL+bwrap) — falling back to Tier 2")
        );
        this.tier3WarningShown = true;
      }
    } catch {
      // Sandbox init is best-effort; never block startup.
    }

    if (this.resume) {
      await this.resumeSession();
    }

    this.rl.prompt();

    if (this.planMode.enabled) {
      const enforcedNote = this.planMode.enforced ? " (enforced — write tools blocked)" : "";
      console.log(chalk.magenta(`  Plan mode: ON${enforcedNote} — no edits allowed (/plan off to disable)\n`));
    }

    this.rl.on("line", async (input: string) => {
      const trimmed = input.trim();
      if (!trimmed) {
        this.rl.prompt();
        return;
      }

      if (trimmed === "/exit" || trimmed === "/quit") {
        this.stop();
        return;
      }

      if (trimmed === "/help") {
        this.printHelp();
        this.rl.prompt();
        return;
      }

      if (trimmed === "/clear") {
        this.history = [];
        console.log(chalk.dim("  Conversation cleared.\n"));
        this.rl.prompt();
        return;
      }

      if (trimmed === "/files") {
        console.log(this.contextEngine.getFileTree());
        this.rl.prompt();
        return;
      }

      if (trimmed === "/models") {
        await this.handleModelsCommand();
        this.rl.prompt();
        return;
      }

      if (trimmed === "/plan" || trimmed.startsWith("/plan ")) {
        this.handlePlanCommand(trimmed.slice("/plan".length).trim());
        this.rl.prompt();
        return;
      }

      if (trimmed.startsWith("/agent ")) {
        await this.handleAgentCommand(trimmed.slice(7));
        this.rl.prompt();
        return;
      }

      if (trimmed === "/mcp") {
        this.handleMcpCommand();
        this.rl.prompt();
        return;
      }

      if (trimmed === "/plugins") {
        this.handlePluginsCommand();
        this.rl.prompt();
        return;
      }

      if (trimmed === "/undo") {
        await this.handleUndoCommand();
        this.rl.prompt();
        return;
      }

      if (trimmed === "/redo") {
        await this.handleRedoCommand();
        this.rl.prompt();
        return;
      }

      if (trimmed === "/snapshot") {
        await this.handleSnapshotCommand();
        this.rl.prompt();
        return;
      }

      if (trimmed === "/share") {
        this.handleShareCommand();
        this.rl.prompt();
        return;
      }

      if (trimmed === "/theme" || trimmed.startsWith("/theme ")) {
        this.handleThemeCommand(trimmed.slice("/theme".length).trim());
        this.rl.prompt();
        return;
      }

      if (trimmed === "/tier" || trimmed.startsWith("/tier ")) {
        this.handleTierCommand(trimmed.slice("/tier".length).trim());
        this.rl.prompt();
        return;
      }

      if (trimmed === "/continue") {
        this.handleContinueCommand();
        this.rl.prompt();
        return;
      }

      if (trimmed === "/facts" || trimmed.startsWith("/facts ") || trimmed.startsWith("/fact ")) {
        await this.handleFactsCommand(trimmed);
        this.rl.prompt();
        return;
      }

      if (trimmed === "/orchestrate" || trimmed.startsWith("/orchestrate ")) {
        await this.handleOrchestrateCommand(trimmed.slice("/orchestrate".length).trim());
        this.rl.prompt();
        return;
      }

      if (trimmed === "/automation" || trimmed.startsWith("/automation ")) {
        this.handleAutomationCommand(trimmed.slice("/automation".length).trim());
        this.rl.prompt();
        return;
      }

      if (trimmed === "/agents") {
        this.handleAgentsCommand();
        this.rl.prompt();
        return;
      }

      if (trimmed === "/acp" || trimmed.startsWith("/acp ")) {
        await this.handleAcpCommand(trimmed.slice("/acp".length).trim());
        this.rl.prompt();
        return;
      }

      await this.recordEvent({ type: "user-message", text: trimmed });
      await this.handleChat(trimmed);
      this.rl.prompt();
    });

    this.rl.on("close", () => {
      console.log(chalk.dim("\n  Goodbye.\n"));
      process.exit(0);
    });
  }

  private async handleModelsCommand(): Promise<void> {
    if (!this.registry || !this.config) {
      console.log(chalk.dim("  Model switching not available (no provider registry/config).\n"));
      return;
    }

    // Close current readline before running selector (selector takes over stdin)
    this.rl.close();

    const config = this.config;
    const snapshot = await discoverAll(config);
    const result = await runSelectorUI(snapshot, () => discoverAll(config));

    // Recreate readline after selector finishes
    this.rl = readline.createInterface({
      input: stdin,
      output: stdout,
      prompt: this.getPrompt(),
    });

    if (result.action === "select") {
      try {
        this.model = this.registry.languageModel(`${result.provider}:${result.model}`);
        this.provider = result.provider;
        this.modelName = result.model;
        console.log(chalk.green(`  Switched to ${result.provider}/${result.model}\n`));
      } catch (err) {
        console.error(chalk.red(`  Failed to switch model: ${(err as Error).message}\n`));
      }
    } else if (result.action === "configure") {
      await runConfigureUI(config);
      console.log(chalk.dim("  Run /models again to pick up the newly configured provider.\n"));
    } else if (result.action === "non_interactive") {
      console.log(chalk.dim("  Model selector requires an interactive terminal.\n"));
    }
    // "quit" — fall straight back through to the maxi> prompt, no message needed.
  }

  private askQuestion(question: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question(question, (answer) => resolve(answer));
    });
  }

  /**
   * Interactive approval prompt. Options: (y)es once / (a)lways this session /
   * (n)o. Defaults to 'n' on empty input or EOF.
   */
  private async promptForApproval(
    toolName: string,
    target: string
  ): Promise<"yes" | "session-allow" | "deny"> {
    const question = chalk.yellow(
      `\n  Approval required for ${toolName}:\n    ${target}\n  (y)es once / (a)lways this session / (n)o [n]: `
    );
    const answer = (await this.askQuestion(question)).trim().toLowerCase();
    if (answer === "y" || answer === "yes") return "yes";
    if (answer === "a" || answer === "always") return "session-allow";
    return "deny";
  }

  private async handleChat(input: string): Promise<void> {
    this.history.push({ role: "user", content: input });
    await this.ensureFrozenPrompt();

    const requestTimeoutMs = this.config?.requestTimeoutMs ?? 120_000;
    const compactResult: CompactResult = await compactHistory(
      this.history,
      this.compactionConfig,
      this.model,
      this.frozenSystemPrompt,
      requestTimeoutMs
    );
    if (compactResult.didCompact) {
      this.history = compactResult.history;
      await this.recordEvent({
        type: "session-meta",
        key: "compacted",
        value: `${compactResult.method}:${compactResult.tokensBefore}->${compactResult.tokensAfter}`,
      });
    }

    const reminder = this.buildVolatileReminder();
    const messages = [
      ...(reminder ? [{ role: "user" as const, content: reminder }] : []),
      ...this.history.map((h) => ({
        role: h.role,
        content: h.content,
      })),
    ];

    process.stdout.write(chalk.dim("  "));
    let fullText = "";
    let toolCallCount = 0;
    let usageRecorded = false;

    const abortController = new AbortController();
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    try {
      const result = streamText({
        model: this.model,
        system: this.frozenSystemPrompt,
        messages,
        tools: this.getTools(),
        toolChoice: "auto",
        stopWhen: isStepCount(8),
        abortSignal: abortController.signal,
        ...(this.provider === "anthropic"
          ? { providerOptions: { anthropic: { cacheControl: { type: "ephemeral" as const } } } }
          : {}),
        onError: () => {
          this.spinner.stop();
        },
        onStepFinish: (step: {
          toolCalls?: Array<{ toolName: string }>;
          usage?: { totalTokens?: number };
        }) => {
          for (const tc of step.toolCalls ?? []) {
            toolCallCount++;
            if (this.spinner.isEnabled()) {
              this.spinner.update(`Running ${tc.toolName}...`);
            }
          }
          // Phase 4.3 — record tokens from provider usage metadata when present.
          const totalTokens = step.usage?.totalTokens;
          if (typeof totalTokens === "number" && totalTokens > 0) {
            this.governor.recordTokens(totalTokens);
            usageRecorded = true;
          }
        },
      });

      // Start spinner for LLM thinking
      this.spinner.start("Thinking...");

      const consumeStream = async (): Promise<void> => {
        for await (const textPart of result.textStream) {
          // Stop spinner on first text chunk
          if (this.spinner.isEnabled() && fullText === "") {
            this.spinner.stop();
          }
          process.stdout.write(textPart);
          fullText += textPart;
        }
        // Surface async stream errors into the catch block (AI SDK v7 lazy stream)
        await result.text;
      };

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          abortController.abort();
          this.spinner.stop();
          reject(new Error(`Request timed out after ${requestTimeoutMs}ms`));
        }, requestTimeoutMs);
      });

      // Race the stream consumption against the timeout so a hung stream
      // cannot leave handleChat pending forever.
      const consumePromise = consumeStream();
      await Promise.race([consumePromise, timeoutPromise]);
      // Swallow any late rejection from the abandoned stream consumer.
      consumePromise.catch(() => {});

      process.stdout.write("\n\n");

      if (toolCallCount > 0) {
        fullText += `\n\n[Executed ${toolCallCount} tool call${toolCallCount > 1 ? "s" : ""}]`;
      }

      // Phase 4.3 — estimate tokens (chars/4) when provider usage metadata is absent.
      if (!usageRecorded && fullText.length > 0) {
        this.governor.recordTokens(Math.ceil(fullText.length / 4));
      }

      this.history.push({ role: "assistant", content: fullText });
      await this.recordEvent({ type: "assistant-message", text: fullText });
    } catch (err) {
      this.spinner.stop();
      if (timedOut) {
        console.error(chalk.red(`\n  Request timed out after ${requestTimeoutMs}ms\n`));
      } else {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\n  Error: ${message}\n`));
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private async handleAgentCommand(input: string): Promise<void> {
    if (this.planMode.enabled) {
      console.log(
        chalk.yellow("  Plan mode is ON — agents are blocked because they may edit files. Use /plan off first.\n")
      );
      return;
    }

    if (!this.orchestrator) {
      console.log(chalk.dim("  Agent orchestrator not configured.\n"));
      return;
    }

    const parts = input.split(/\s+/);
    const agentName = parts[0];
    const prompt = parts.slice(1).join(" ");

    if (!agentName || !prompt) {
      console.log(chalk.dim("  Usage: /agent <agent-name> <prompt>\n"));
      return;
    }

      const agent = this.orchestrator.getAgent(agentName);
    if (!agent) {
      console.log(chalk.dim(`  Agent "${agentName}" not found. Available: ${this.orchestrator.listAgents().map((a: { name: string }) => a.name).join(", ")}\n`));
      return;
    }

    console.log(chalk.dim(`  Running agent "${agentName}"...\n`));
    try {
      const result = await this.orchestrator.runAgent(agentName, prompt, (toolName: string, _args: Record<string, unknown>) => {
        console.log(chalk.dim(`  [tool: ${toolName}]`));
      });
      console.log(result.text + "\n");
    } catch (err) {
      console.error(chalk.red(`  Agent error: ${(err as Error).message}\n`));
    }
  }

  private async handleOrchestrateCommand(input: string): Promise<void> {
    if (this.planMode.enabled) {
      console.log(
        chalk.yellow("  Plan mode is ON — orchestration is blocked because agents may edit files. Use /plan off first.\n")
      );
      return;
    }

    if (!this.orchestrator) {
      console.log(chalk.dim("  Agent orchestrator not configured.\n"));
      return;
    }

    const task = input.trim();
    if (!task) {
      console.log(chalk.dim("  Usage: /orchestrate <task>\n"));
      return;
    }

    try {
      const route = this.orchestrator.routeTask(task);
      console.log(chalk.dim(`  Routed to agent "${route.agentName}" (score ${route.score})...\n`));
      const result = await this.orchestrator.runAgent(route.agentName, task, (toolName: string, _args: Record<string, unknown>) => {
        console.log(chalk.dim(`  [tool: ${toolName}]`));
      });
      console.log(result.text + "\n");
    } catch (err) {
      console.error(chalk.red(`  Orchestrate error: ${(err as Error).message}\n`));
    }
  }

  private handleAutomationCommand(input: string): void {
    if (!this.automationEngine) {
      console.log(chalk.dim("  Automation engine not configured.\n"));
      return;
    }

    const parts = input.split(/\s+/).filter(Boolean);
    const sub = parts[0] ?? "";

    if (sub === "add") {
      const name = parts[1];
      const cron = parts.slice(2, 7).join(" ");
      const agent = parts[7];
      const prompt = parts.slice(8).join(" ");
      if (!name || !agent || !prompt || parts.length < 8) {
        console.log(chalk.dim("  Usage: /automation add <name> <minute> <hour> <dom> <month> <dow> <agent> <prompt>\n"));
        return;
      }
      try {
        const id = this.automationEngine.registerJob({
          name,
          trigger: { type: "cron", schedule: cron },
          agentName: agent,
          prompt,
          enabled: true,
        });
        console.log(chalk.green(`  Automation job "${name}" registered (id: ${id})\n`));
      } catch (err) {
        console.error(chalk.red(`  Failed to register job: ${(err as Error).message}\n`));
      }
      return;
    }

    if (sub === "remove") {
      const id = parts[1];
      if (!id) {
        console.log(chalk.dim("  Usage: /automation remove <id>\n"));
        return;
      }
      const removed = this.automationEngine.removeJob(id);
      if (removed) {
        console.log(chalk.green(`  Removed automation job ${id}\n`));
      } else {
        console.log(chalk.yellow(`  No automation job with id "${id}"\n`));
      }
      return;
    }

    const jobs = this.automationEngine.listJobs();
    if (jobs.length === 0) {
      console.log(chalk.dim("  No automation jobs registered.\n"));
      return;
    }
    for (const job of jobs) {
      const trigger = job.trigger.type === "cron" ? job.trigger.schedule : `event:${job.trigger.event}`;
      console.log(
        chalk.cyan(`  ${job.id}`) +
          chalk.dim(` — ${job.name} (${trigger}) → ${job.agentName}${job.enabled ? "" : " [disabled]"}`)
      );
    }
    console.log();
  }

  private handleAgentsCommand(): void {
    if (!this.orchestrator) {
      console.log(chalk.dim("  Agent orchestrator not configured.\n"));
      return;
    }

    const agents = this.orchestrator.listAgents();
    if (agents.length === 0) {
      console.log(chalk.dim("  No agents registered.\n"));
      return;
    }
    for (const agent of agents) {
      console.log(chalk.cyan(`  ${agent.name}`) + chalk.dim(` — ${agent.description}`));
    }

    const tasks = this.orchestrator.listTasks();
    if (tasks.length > 0) {
      console.log(chalk.dim("\n  Recent tasks:"));
      for (const task of tasks.slice(-10)) {
        console.log(chalk.dim(`    ${task.id} [${task.status}] ${task.agentName}: ${task.prompt.slice(0, 60)}`));
      }
    }
    console.log();
  }

  private async handleAcpCommand(input: string): Promise<void> {
    const parts = input.split(/\s+/).filter(Boolean);
    const sub = parts[0] ?? "";

    if (sub === "connect") {
      if (!this.acpClient) {
        console.log(chalk.dim("  ACP client not configured.\n"));
        return;
      }
      const name = parts[1] ?? "acp-agent";
      const description = parts.slice(2).join(" ") || "External ACP-backed agent";
      try {
        await this.acpClient.connect();
        if (this.orchestrator) {
          this.orchestrator.registerAgent(this.acpClient.toAgentConfig({ name, description }));
        }
        console.log(chalk.green(`  ACP client connected. Agent "${name}" registered.\n`));
      } catch (err) {
        console.error(chalk.red(`  ACP connect failed: ${(err as Error).message}\n`));
      }
      return;
    }

    if (sub === "disconnect") {
      if (!this.acpClient) {
        console.log(chalk.dim("  ACP client not configured.\n"));
        return;
      }
      try {
        await this.acpClient.close();
        console.log(chalk.dim("  ACP client disconnected.\n"));
      } catch (err) {
        console.error(chalk.red(`  ACP disconnect failed: ${(err as Error).message}\n`));
      }
      return;
    }

    if (sub === "start") {
      if (!this.acpServer) {
        console.log(chalk.dim("  ACP server not configured.\n"));
        return;
      }
      this.acpServer.start();
      console.log(chalk.green("  ACP server started.\n"));
      return;
    }

    if (sub === "stop") {
      if (!this.acpServer) {
        console.log(chalk.dim("  ACP server not configured.\n"));
        return;
      }
      this.acpServer.close();
      console.log(chalk.dim("  ACP server stopped.\n"));
      return;
    }

    if (!this.acpClient && !this.acpServer) {
      console.log(chalk.dim("  ACP not configured.\n"));
      return;
    }
    if (this.acpClient) {
      console.log(chalk.cyan("  ACP client") + chalk.dim(" — configured (/acp connect <name>, /acp disconnect)"));
    }
    if (this.acpServer) {
      console.log(chalk.cyan("  ACP server") + chalk.dim(" — configured (/acp start, /acp stop)"));
    }
    console.log();
  }

  private handleMcpCommand(): void {
    if (!this.mcpClient) {
      console.log(chalk.dim("  MCP client not configured.\n"));
      return;
    }

    const servers = this.mcpClient.listServers();
    if (servers.length === 0) {
      console.log(chalk.dim("  No MCP servers connected.\n"));
      return;
    }

    for (const name of servers) {
      const tools = this.mcpClient.getTools(name);
      console.log(chalk.cyan(`  ${name}`) + chalk.dim(` (${tools.length} tool${tools.length !== 1 ? "s" : ""})`));
      for (const tool of tools) {
        console.log(chalk.dim(`    - ${tool.name}: ${tool.description}`));
      }
    }
    console.log();
  }

  private handlePluginsCommand(): void {
    if (this.loadedPlugins.length === 0) {
      console.log(chalk.dim("  No plugins loaded.\n"));
      return;
    }

    for (const p of this.loadedPlugins) {
      console.log(chalk.cyan(`  ${p.name}`) + chalk.dim(` — ${p.description} (${p.tools.length} tool${p.tools.length !== 1 ? "s" : ""})`));
      for (const toolName of p.tools) {
        console.log(chalk.dim(`    - ${toolName}`));
      }
    }
    console.log();
  }

  private async handleUndoCommand(): Promise<void> {
    if (!this.snapshotManager) {
      console.log(chalk.dim("  Snapshots not available.\n"));
      return;
    }
    const result = await this.snapshotManager.undo();
    if (result.success) {
      console.log(chalk.green(`  ${result.message}\n`));
    } else {
      console.log(chalk.yellow(`  ${result.message}\n`));
    }
  }

  private async handleRedoCommand(): Promise<void> {
    if (!this.snapshotManager) {
      console.log(chalk.dim("  Snapshots not available.\n"));
      return;
    }
    const result = await this.snapshotManager.redo();
    if (result.success) {
      console.log(chalk.green(`  ${result.message}\n`));
    } else {
      console.log(chalk.yellow(`  ${result.message}\n`));
    }
  }

  private async handleSnapshotCommand(): Promise<void> {
    if (!this.snapshotManager) {
      console.log(chalk.dim("  Snapshots not available.\n"));
      return;
    }
    const result = await this.snapshotManager.saveSnapshot();
    if (result.success) {
      console.log(chalk.green(`  ${result.message}\n`));
    } else {
      console.log(chalk.red(`  ${result.message}\n`));
    }
  }

  private handleShareCommand(): void {
    if (this.history.length === 0) {
      console.log(chalk.dim("  No conversation to export.\n"));
      return;
    }
    const exportDir = join(process.cwd(), ".maxi", "exports");
    if (!existsSync(exportDir)) {
      mkdirSync(exportDir, { recursive: true });
    }
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = join(exportDir, `maxi-export-${ts}.md`);
    const header = `# Maxi Conversation Export\n\n**Date:** ${new Date().toISOString()}\n\n**Model:** ${this.provider}/${this.modelName}\n\n---\n\n`;
    const body = this.history.map((entry) => {
      const role = entry.role === "user" ? "**You**" : "**Maxi**";
      return `### ${role}\n\n${entry.content}\n`;
    }).join("\n");
    writeFileSync(filePath, header + body, "utf-8");
    console.log(chalk.green(`  Conversation exported to ${filePath}\n`));
  }

  private handleThemeCommand(arg: string): void {
    if (!arg) {
      const themes = listThemes();
      console.log(chalk.dim("\n  Available themes:"));
      for (const t of themes) {
        const marker = t.name === this.theme.name ? " *" : "";
        console.log(chalk.dim(`    ${t.name}${marker}  ${t.preview}`));
      }
      console.log(chalk.dim("\n  Usage: /theme <name>\n"));
      return;
    }
    if (!isValidTheme(arg)) {
      console.log(chalk.red(`  Unknown theme "${arg}". Use /theme to list available themes.\n`));
      return;
    }
    this.theme = getTheme(arg);
    this.rl.setPrompt(this.getPrompt());
    console.log(chalk.green(`  Theme switched to "${arg}"\n`));
  }

  /** Explicit user re-authorization: reset the session governor's ceilings. */
  private handleContinueCommand(): void {
    this.governor.reset();
    void this.recordEvent({ type: "session-meta", key: "governor-reset", value: "user" });
    console.log(chalk.green("  Session governor reset — ceilings re-armed for this session.\n"));
  }

  /**
   * Phase 6 — /facts and /fact commands.
   *   /facts            — list numbered facts
   *   /fact add <text>  — add a fact (source: user-correction)
   *   /fact remove <n>  — remove fact by 1-based list number
   */
  private async handleFactsCommand(input: string): Promise<void> {
    const trimmed = input.trim();

    if (trimmed === "/facts") {
      const facts = this.factStore.list();
      if (facts.length === 0) {
        console.log(chalk.dim("  No facts recorded.\n"));
        return;
      }
      console.log(chalk.dim("\n  Facts:"));
      facts.forEach((f, i) => {
        const source = f.source === "user-correction" ? "user" : "inferred";
        console.log(chalk.dim(`    ${i + 1}. [${source}] ${f.fact}`));
      });
      console.log();
      return;
    }

    if (trimmed.startsWith("/fact add ")) {
      const text = trimmed.slice("/fact add ".length).trim();
      if (!text) {
        console.log(chalk.dim("  Usage: /fact add <text>\n"));
        return;
      }
      const { id, dedup } = await this.factStore.add(text, "user-correction", this.sessionId);
      // Mid-session fact: include in the volatile reminder, NOT the frozen prompt.
      this.midSessionFacts.push(text);
      void this.recordEvent({ type: "session-meta", key: "fact-recorded", value: id });
      console.log(
        chalk.green(
          dedup
            ? `  Fact updated (dedup): ${text}\n`
            : `  Fact recorded (${id}): ${text}\n`
        )
      );
      return;
    }

    if (trimmed.startsWith("/fact remove ")) {
      const n = Number(trimmed.slice("/fact remove ".length).trim());
      const facts = this.factStore.list();
      if (!Number.isInteger(n) || n < 1 || n > facts.length) {
        console.log(chalk.dim(`  No fact at position ${n}. Use /facts to list.\n`));
        return;
      }
      const target = facts[n - 1];
      await this.factStore.remove(target.id);
      console.log(chalk.green(`  Removed fact: ${target.fact}\n`));
      return;
    }

    console.log(chalk.dim("  Usage: /facts | /fact add <text> | /fact remove <n>\n"));
  }

  private handleTierCommand(arg: string): void {
    if (!arg) {
      console.log(chalk.cyan(`  Current autonomy tier: ${this.currentTier}`));
      console.log(chalk.dim("  Tier 1 — Assistant: always-ask (every non-allowlisted action pauses)"));
      console.log(chalk.dim("  Tier 2 — Supervised: plan-then-ask (pauses before flagged steps)"));
      console.log(chalk.dim("  Tier 3 — Autonomous: auto-with-gates (requires Phase 4 — feature-flagged off)"));
      console.log(chalk.dim("  Usage: /tier <1|2|3>\n"));
      return;
    }
    const parsed = Number(arg);
    if (parsed !== 1 && parsed !== 2 && parsed !== 3) {
      console.log(chalk.red(`  Invalid tier "${arg}". Use /tier <1|2|3>.\n`));
      return;
    }
    const requested = parsed as AutonomyTier;
    const resolved = resolveTier({
      autonomy: { tier: requested },
      features: this.config?.features,
      sandboxAvailable: this.sandboxAvailable,
    });
    if (resolved.tier3Blocked && !this.tier3WarningShown) {
      console.log(chalk.yellow("  Tier 3 requires Phase 4 (gates/sandbox/governor) — falling back to Tier 2"));
      this.tier3WarningShown = true;
    }
    this.approvalPolicy = tierToPolicy(resolved.tier);
    this.currentTier = resolved.tier;
    void this.recordEvent({ type: "session-meta", key: "tier-changed", value: String(resolved.tier) });
    console.log(chalk.green(`  Autonomy tier set to ${resolved.tier}\n`));
  }

  private handlePlanCommand(arg: string): void {
    if (arg === "off" || arg === "exit") {
      this.planMode.enabled = false;
      this.planMode.phase = WorkflowPhase.IDLE;
      console.log(chalk.dim("  Plan mode OFF — edits are allowed again.\n"));
      return;
    }

    if (arg === "enforced") {
      this.planMode.enforced = !this.planMode.enforced;
      if (this.planMode.enforced) {
        console.log(chalk.magenta("  Plan mode enforcement ON — write tool calls will be blocked while plan mode is active."));
      } else {
        console.log(chalk.dim("  Plan mode enforcement OFF — write tools are allowed (soft mode via system prompt).\n"));
      }
      return;
    }

    this.planMode.enabled = true;
    this.planMode.phase = WorkflowPhase.PLANNING;
    console.log(chalk.magenta("  Plan mode ON — no edits will be made."));
    console.log(chalk.dim("  Research and planning only. Use /plan off to leave plan mode."));
    if (this.planMode.enforced) {
      console.log(chalk.magenta("  Enforcement is ON — write tools will be hard-blocked.\n"));
    } else {
      console.log(chalk.dim("  Enforcement is OFF — soft mode via system prompt only. Use /plan enforced to toggle.\n"));
    }
  }

  /** Compose the stable system prompt (frozen at REPL start, never mutated). */
  private buildSystemPrompt(context: string): string {
    const sections: string[] = [
      `${this.systemPrompt}\n\n# Codebase Context\n${context}`,
      "\n\n# Planning\n" +
        "For multi-step work, maintain a plan with the plan_update and plan_advance tools. " +
        "Call plan_update to create or revise the step list, and plan_advance to mark a step in-progress or verified.",
    ];

    // Phase 6 — facts render into the STABLE prefix region. Only facts present
    // at REPL start appear here; mid-session additions go to the volatile
    // reminder instead (see buildVolatileReminder) and join the frozen prefix
    // only on the next session.
    const factsSection = this.factStore.renderSection();
    if (factsSection) sections.push(`\n\n${factsSection}`);

    // Phase 6 — architecture map (if it exists) renders into the frozen prefix.
    const archSection = renderArchMapSection(this.archMap);
    if (archSection) sections.push(`\n\n${archSection}`);

    return sections.join("");
  }

  /** Build the frozen system prompt once from the initial project snapshot. */
  private async ensureFrozenPrompt(): Promise<void> {
    if (this.frozenSystemPrompt) return;
    await this.factStore.load();
    this.archMap = await readArchMap(this.cwd);
    const context = await this.contextEngine.getContextForPrompt("", 8000);
    this.frozenSystemPrompt = this.buildSystemPrompt(context);
  }

  /** Volatile per-turn state (plan block, plan-mode reminder) as a user-role message. */
  private buildVolatileReminder(): string {
    const parts: string[] = [];
    const plan = this.planStore.get();
    if (plan) {
      parts.push(renderPlanBlock(plan));
    }
    if (this.planMode.enabled) {
      parts.push(
        "Plan mode is ACTIVE. Do NOT create, modify, or delete any files. " +
          "Research the request and respond with a step-by-step implementation plan for the user to review and approve."
      );
    }
    // Phase 6 — facts added mid-session go to the VOLATILE reminder, NOT the
    // frozen system prompt. They join the frozen prefix only on the next session.
    if (this.midSessionFacts.length > 0) {
      parts.push(
        "New facts recorded this session:\n" +
          this.midSessionFacts.map((f) => `- ${f}`).join("\n")
      );
    }
    if (parts.length === 0) return "";
    return `<system-reminder>\n${parts.join("\n\n")}\n</system-reminder>`;
  }

  private printHelp(): void {
    console.log(chalk.dim("\n  Commands:"));
    console.log(chalk.dim("    /help     — Show this help"));
    console.log(chalk.dim("    /clear    — Clear conversation history"));
    console.log(chalk.dim("    /files    — Show indexed file tree"));
    console.log(chalk.dim("    /models   — List and switch models"));
    console.log(chalk.dim("    /agent <name> <prompt> — Run a specific agent"));
    console.log(chalk.dim("    /orchestrate <task> — Route a task to the best agent and run it"));
    console.log(chalk.dim("    /automation — List automation jobs (/automation add|remove)"));
    console.log(chalk.dim("    /agents — List registered agents and task status"));
    console.log(chalk.dim("    /acp — Connect/disconnect ACP agents"));
    console.log(chalk.dim("    /plan     — Toggle plan mode (read-only planning)"));
    console.log(chalk.dim("    /plan enforced — Toggle hard enforcement of plan mode (blocks write tools)"));
    console.log(chalk.dim("    /mcp      — Show connected MCP servers and tools"));
    console.log(chalk.dim("    /plugins  — Show loaded plugins and their tools"));
    console.log(chalk.dim("    /undo     — Undo last file change (snapshot-based)"));
    console.log(chalk.dim("    /redo     — Redo last undone change"));
    console.log(chalk.dim("    /snapshot — Manually save a snapshot"));
    console.log(chalk.dim("    /share    — Export conversation to markdown file"));
    console.log(chalk.dim("    /theme    — Switch UI theme (default, dark, light, mono, dracula, nord)"));
    console.log(chalk.dim("    /tier     — Show or switch autonomy tier (/tier <1|2|3>)"));
    console.log(chalk.dim("    /continue — Re-authorize after the session governor halts (resets ceilings)"));
    console.log(chalk.dim("    /facts    — List recorded facts"));
    console.log(chalk.dim("    /fact add <text> — Record a fact (persists across sessions)"));
    console.log(chalk.dim("    /fact remove <n> — Remove a fact by list number"));
    console.log(chalk.dim("    /exit     — Exit Maxi\n"));
  }

  stop(): void {
    this.running = false;
    this.rl.close();
    if (this.mcpClient) {
      this.mcpClient.disconnectAll().catch(() => {});
    }
    if (this.destroyPlugins) {
      this.destroyPlugins().catch(() => {});
    }
  }

  /** True while plan mode is active (no edits allowed). */
  isPlanMode(): boolean {
    return this.planMode.enabled === true;
  }

  isRunning(): boolean {
    return this.running;
  }
}
