import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentOrchestrator, AgentRunResult } from "../agents/orchestrator.js";

/** A single field of a 5-field cron schedule. */
type CronField = {
  /** Set of allowed values (0-based for minute/hour, 1-based for day/month/dow). */
  values: Set<number>;
  /** True when the field is `*` (matches every value). */
  wildcard: boolean;
};

/** Parsed representation of a 5-field cron schedule. */
export interface CronSchedule {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

/** Trigger configuration for an automation job. */
export type AutomationTrigger =
  | { type: "cron"; schedule: string }
  | { type: "event"; event: string };

/** A registered automation job. */
export interface AutomationJob {
  id: string;
  name: string;
  trigger: AutomationTrigger;
  /** Agent name to dispatch to via the orchestrator. */
  agentName: string;
  /** Prompt passed to the agent. */
  prompt: string;
  /** Whether the job is currently enabled. */
  enabled: boolean;
}

/** A single recorded run of a job. */
export interface JobRun {
  jobId: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  finishedAt?: number;
  result?: string;
  error?: string;
}

/** Persisted shape of the automation store. */
interface AutomationStore {
  jobs: AutomationJob[];
  runs: JobRun[];
}

/**
 * Parses a single cron field into a set of allowed values.
 *
 * Supports `*`, a single number, ranges (`1-5`), and comma-separated lists
 * (`1,3,5`). Ranges and lists may be combined (e.g. `1-3,7`).
 *
 * @param field The raw field string.
 * @param min Minimum allowed value (inclusive).
 * @param max Maximum allowed value (inclusive).
 */
export function parseCronField(field: string, min: number, max: number): CronField {
  const trimmed = field.trim();
  if (trimmed === "*") {
    return { values: new Set<number>(), wildcard: true };
  }

  const values = new Set<number>();
  for (const part of trimmed.split(",")) {
    const p = part.trim();
    if (p === "") throw new Error(`Invalid cron field: "${field}"`);
    const rangeMatch = p.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (start > end) throw new Error(`Invalid cron range: "${p}"`);
      for (let v = start; v <= end; v++) {
        if (v < min || v > max) throw new Error(`Cron value ${v} out of range [${min},${max}]`);
        values.add(v);
      }
    } else if (/^\d+$/.test(p)) {
      const v = Number(p);
      if (v < min || v > max) throw new Error(`Cron value ${v} out of range [${min},${max}]`);
      values.add(v);
    } else {
      throw new Error(`Invalid cron field token: "${p}"`);
    }
  }
  return { values, wildcard: false };
}

/**
 * Parses a standard 5-field cron schedule:
 * `minute hour day-of-month month day-of-week`.
 */
export function parseCron(schedule: string): CronSchedule {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Cron schedule must have 5 fields, got ${parts.length}: "${schedule}"`);
  }
  return {
    minute: parseCronField(parts[0], 0, 59),
    hour: parseCronField(parts[1], 0, 23),
    dayOfMonth: parseCronField(parts[2], 1, 31),
    month: parseCronField(parts[3], 1, 12),
    dayOfWeek: parseCronField(parts[4], 0, 6),
  };
}

/** Returns true when the given date matches the cron schedule. */
export function cronMatches(schedule: CronSchedule, date: Date): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1; // 1-based
  const dayOfWeek = date.getDay(); // 0 = Sunday

  const match = (field: CronField, value: number): boolean =>
    field.wildcard || field.values.has(value);

  return (
    match(schedule.minute, minute) &&
    match(schedule.hour, hour) &&
    match(schedule.dayOfMonth, dayOfMonth) &&
    match(schedule.month, month) &&
    match(schedule.dayOfWeek, dayOfWeek)
  );
}

/**
 * Automation engine: registers jobs (cron or event triggers), schedules them on
 * a background timer, dispatches to an injected AgentOrchestrator, tracks runs,
 * and persists jobs to `.maxi/automations.json`.
 */
export class AutomationEngine {
  private cwd: string;
  private orchestrator: AgentOrchestrator;
  private jobs: Map<string, AutomationJob> = new Map();
  private runs: JobRun[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** Tracks the last minute checked so each cron job fires at most once per minute. */
  private lastCheckedMinute = -1;

  constructor(cwd: string, orchestrator: AgentOrchestrator) {
    this.cwd = cwd;
    this.orchestrator = orchestrator;
    this.load();
  }

  // ── Public API ──────────────────────────────────────────────

  /** Register a job. Returns the job id. */
  registerJob(job: Omit<AutomationJob, "id"> & { id?: string }): string {
    const id = job.id ?? `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (this.jobs.has(id)) throw new Error(`Job "${id}" already registered`);
    if (job.trigger.type === "cron") {
      // Validate the schedule eagerly so bad schedules fail at registration.
      parseCron(job.trigger.schedule);
    }
    const full: AutomationJob = { ...job, id };
    this.jobs.set(id, full);
    this.save();
    return id;
  }

  /** Remove a job by id. Returns true if a job was removed. */
  removeJob(id: string): boolean {
    const removed = this.jobs.delete(id);
    if (removed) this.save();
    return removed;
  }

  /** List all registered jobs. */
  listJobs(): AutomationJob[] {
    return [...this.jobs.values()];
  }

  /** Get a single job by id. */
  getJob(id: string): AutomationJob | undefined {
    return this.jobs.get(id);
  }

  /** Start the background scheduler. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastCheckedMinute = -1;
    this.timer = setInterval(() => this.tick(), 1000);
    // Prevent the timer from keeping the process alive indefinitely.
    this.timer.unref?.();
  }

  /** Stop the background scheduler. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Whether the scheduler is running. */
  isRunning(): boolean {
    return this.running;
  }

  /** Get recorded runs, optionally filtered by job id. */
  getRuns(jobId?: string): JobRun[] {
    if (!jobId) return [...this.runs];
    return this.runs.filter((r) => r.jobId === jobId);
  }

  /**
   * Fire an event trigger. Any enabled job whose trigger is an event matching
   * `event` will be dispatched.
   */
  emit(event: string): void {
    for (const job of this.jobs.values()) {
      if (!job.enabled) continue;
      if (job.trigger.type === "event" && job.trigger.event === event) {
        void this.dispatch(job);
      }
    }
  }

  // ── Scheduling ──────────────────────────────────────────────

  /** Background tick: fire any cron jobs whose schedule matches the current minute. */
  private tick(): void {
    if (!this.running) return;
    const now = new Date();
    const minute = now.getMinutes();
    if (minute === this.lastCheckedMinute) return;
    this.lastCheckedMinute = minute;

    for (const job of this.jobs.values()) {
      if (!job.enabled) continue;
      if (job.trigger.type !== "cron") continue;
      let schedule: CronSchedule;
      try {
        schedule = parseCron(job.trigger.schedule);
      } catch {
        // Invalid schedule — skip (already validated at registration, defensive).
        continue;
      }
      if (cronMatches(schedule, now)) {
        void this.dispatch(job);
      }
    }
  }

  // ── Dispatch ────────────────────────────────────────────────

  /** Dispatch a job to the orchestrator and record the run. */
  private async dispatch(job: AutomationJob): Promise<void> {
    const run: JobRun = {
      jobId: job.id,
      status: "running",
      startedAt: Date.now(),
    };
    this.runs.push(run);
    this.save();

    try {
      const result: AgentRunResult = await this.orchestrator.runAgent(
        job.agentName,
        job.prompt
      );
      run.status = "completed";
      run.finishedAt = Date.now();
      run.result = result.text;
    } catch (err) {
      run.status = "failed";
      run.finishedAt = Date.now();
      run.error = (err as Error).message;
    }
    this.save();
  }

  // ── Persistence ─────────────────────────────────────────────

  private getStorePath(): string {
    return join(this.cwd, ".maxi", "automations.json");
  }

  private load(): void {
    const path = this.getStorePath();
    if (!existsSync(path)) return;
    try {
      const raw = readFileSync(path, "utf8");
      const store = JSON.parse(raw) as AutomationStore;
      if (Array.isArray(store.jobs)) {
        for (const job of store.jobs) {
          if (job && job.id) this.jobs.set(job.id, job);
        }
      }
      if (Array.isArray(store.runs)) {
        this.runs = store.runs;
      }
    } catch {
      // Corrupt store — start fresh rather than crashing.
      this.jobs.clear();
      this.runs = [];
    }
  }

  private save(): void {
    const dir = join(this.cwd, ".maxi");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const store: AutomationStore = {
      jobs: [...this.jobs.values()],
      runs: this.runs,
    };
    writeFileSync(this.getStorePath(), JSON.stringify(store, null, 2), "utf8");
  }
}
