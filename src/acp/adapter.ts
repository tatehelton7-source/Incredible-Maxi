import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { AgentConfig, AgentOrchestrator, AgentRunResult } from "../agents/orchestrator.js";

/**
 * Agent-Client Protocol (ACP) adapter.
 *
 * Implements a minimal JSON-RPC 2.0 message protocol over stdio directly
 * (matching the subprocess plugin pattern in src/plugins/subprocess-loader.ts)
 * so that:
 *   - `AcpClient` can spawn an external ACP-compatible agent process and expose
 *     it as a Maxi `AgentConfig` (registerable with an `AgentOrchestrator`).
 *   - `AcpServer` can expose Maxi's own agents over ACP so external clients can
 *     drive them.
 *
 * No full ACP SDK dependency is used.
 */

/** A single JSON-RPC request sent over the wire. */
export interface AcpRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

/** A single JSON-RPC response received over the wire. */
export interface AcpResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Result of running a task against an ACP agent. */
export interface AcpTaskResult {
  text: string;
  iterations: number;
  toolCalls: number;
}

/** Options for spawning an external ACP agent process. */
export interface AcpClientOptions {
  command: string;
  args?: string[];
  cwd?: string;
  /** Optional custom spawn function (used for testing). */
  spawnFn?: typeof spawn;
  /** Optional custom stdio streams (used for testing). */
  stdio?: { stdin: Writable; stdout: Readable };
  /** Timeout in ms for a single task request. Defaults to 30000. */
  timeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: AcpResponse) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * A client that spawns an external ACP-compatible agent process over stdio,
 * sends task requests, and parses responses. The spawned agent is exposed as a
 * Maxi `AgentConfig` so it can be registered with an `AgentOrchestrator`.
 */
export class AcpClient {
  private proc: ChildProcess | null = null;
  private stdin: Writable | null = null;
  private stdout: Readable | null = null;
  private requestId = 0;
  private pendingRequests: Map<number, PendingRequest> = new Map();
  private buffer = "";
  private timeoutMs: number;
  private spawnFn: typeof spawn;
  private closed = false;

  constructor(private options: AcpClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.spawnFn = options.spawnFn ?? spawn;
  }

  /**
   * Spawn the external agent process and begin listening for responses.
   * Throws if the process cannot be spawned.
   */
  async connect(): Promise<void> {
    if (this.proc) return;

    if (this.options.stdio) {
      this.stdin = this.options.stdio.stdin;
      this.stdout = this.options.stdio.stdout;
      this.setupStreamHandlers();
      return;
    }

    const proc = this.spawnFn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd ?? process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    this.stdin = proc.stdin;
    this.stdout = proc.stdout;

    this.setupStreamHandlers();

    proc.on("error", (err) => {
      this.rejectAll(new Error(`ACP agent process error: ${err.message}`));
    });

    proc.on("exit", (code) => {
      if (!this.closed) {
        this.rejectAll(
          new Error(`ACP agent process exited unexpectedly with code ${code}`)
        );
      }
    });
  }

  private setupStreamHandlers(): void {
    this.stdout?.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        this.handleLine(line);
      }
    });
  }

  private handleLine(line: string): void {
    let response: AcpResponse;
    try {
      response = JSON.parse(line) as AcpResponse;
    } catch {
      // Malformed line — ignore (matching subprocess-loader behavior).
      return;
    }
    if (typeof response.id !== "number") return;
    const pending = this.pendingRequests.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.id);
    pending.resolve(response);
  }

  /**
   * Send a task to the external agent and await its result.
   * Returns the parsed result, or throws on error/timeout.
   */
  async runTask(prompt: string): Promise<AcpTaskResult> {
    const stdin = this.stdin;
    if (!stdin || !stdin.writable) {
      throw new Error("ACP agent not connected. Call connect() first.");
    }

    const id = ++this.requestId;
    const request: AcpRequest = {
      jsonrpc: "2.0",
      id,
      method: "agent/task",
      params: { prompt },
    };

    return new Promise<AcpTaskResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`ACP agent task timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (response: AcpResponse) => {
          if (response.error) {
            reject(new Error(response.error.message));
            return;
          }
          const result = response.result as Partial<AcpTaskResult> | undefined;
          if (!result || typeof result.text !== "string") {
            reject(new Error("ACP agent returned an invalid task result"));
            return;
          }
          resolve({
            text: result.text,
            iterations: result.iterations ?? 1,
            toolCalls: result.toolCalls ?? 0,
          });
        },
        reject,
        timeout,
      });

      stdin.write(JSON.stringify(request) + "\n");
    });
  }

  /**
   * Expose the external agent as a Maxi `AgentConfig` so it can be registered
   * with an `AgentOrchestrator`. The returned config's `systemPrompt` is a
   * marker that identifies this agent as ACP-backed.
   */
  toAgentConfig(config: {
    name: string;
    description: string;
    systemPrompt?: string;
  }): AgentConfig {
    return {
      name: config.name,
      description: config.description,
      systemPrompt:
        config.systemPrompt ??
        `You are an ACP-backed agent. Delegate the user's request to the external agent via the "acp_task" tool.`,
    };
  }

  private rejectAll(err: Error): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }

  /** Close the connection and kill the spawned process (if any). */
  async close(): Promise<void> {
    this.closed = true;
    this.rejectAll(new Error("ACP client closed"));
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.stdin = null;
    this.stdout = null;
  }
}

/** Options for the ACP server. */
export interface AcpServerOptions {
  /** The orchestrator whose agents are exposed over ACP. */
  orchestrator: AgentOrchestrator;
  /** Optional custom stdio streams (used for testing). */
  stdio?: { stdin: Readable; stdout: Writable };
}

/**
 * A server that exposes Maxi's own agents over ACP (JSON-RPC over stdio) so
 * external clients can drive them. Incoming `agent/task` requests are
 * dispatched to the injected `AgentOrchestrator`.
 */
export class AcpServer {
  private stdin: Readable;
  private stdout: Writable;
  private buffer = "";
  private closed = false;

  constructor(private options: AcpServerOptions) {
    this.stdin = options.stdio?.stdin ?? process.stdin;
    this.stdout = options.stdio?.stdout ?? process.stdout;
  }

  /** Start listening on stdio for incoming JSON-RPC requests. */
  start(): void {
    this.stdin.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        this.handleLine(line);
      }
    });
  }

  private handleLine(line: string): void {
    let request: AcpRequest;
    try {
      request = JSON.parse(line) as AcpRequest;
    } catch {
      this.sendError(0, -32700, "Parse error");
      return;
    }

    if (request.jsonrpc !== "2.0" || typeof request.id !== "number") {
      this.sendError(request.id ?? 0, -32600, "Invalid Request");
      return;
    }

    void this.dispatch(request);
  }

  private async dispatch(request: AcpRequest): Promise<void> {
    try {
      switch (request.method) {
        case "agent/list": {
          const agents = this.options.orchestrator.listAgents().map((a) => ({
            name: a.name,
            description: a.description,
          }));
          this.sendResult(request.id, { agents });
          return;
        }
        case "agent/task": {
          const params = request.params as { agentName?: string; prompt?: string };
          const agentName = params.agentName;
          const prompt = params.prompt;
          if (!agentName || typeof prompt !== "string") {
            this.sendError(request.id, -32602, "Invalid params: agentName and prompt required");
            return;
          }
          const result: AgentRunResult = await this.options.orchestrator.runAgent(
            agentName,
            prompt
          );
          this.sendResult(request.id, {
            text: result.text,
            iterations: result.iterations,
            toolCalls: result.toolCalls,
          });
          return;
        }
        default:
          this.sendError(request.id, -32601, `Method not found: ${request.method}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendError(request.id, -32000, message);
    }
  }

  private sendResult(id: number, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private sendError(id: number, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private write(msg: AcpResponse): void {
    if (this.closed || !this.stdout.writable) return;
    this.stdout.write(JSON.stringify(msg) + "\n");
  }

  /** Stop listening and detach from stdio. */
  close(): void {
    this.closed = true;
    this.stdin.removeAllListeners("data");
  }
}
